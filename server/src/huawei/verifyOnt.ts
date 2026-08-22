/** Read-only Huawei MA5680T verification over an interactive SSH CLI. */
import { createHash, timingSafeEqual } from "node:crypto";
import ssh2 from "ssh2";
import type { Client as SshClient, ClientChannel, ConnectConfig } from "ssh2";
import { parseHuaweiOntLog, type ParsedOnt } from "./parseOntLog.js";

const { Client } = ssh2;

type OltConnectionSecret = {
  protocol?: "ssh";
  port?: number;
  username?: string;
  password?: string;
  hostKeySha256?: string;
};

export type OntVerificationTarget = {
  managementIp: string;
  frameNumber: number;
  slotNumber: number;
  ponPortNumber: number;
  ontId: number;
};

export class OltVerificationError extends Error {
  constructor(
    public readonly kind: "configuration" | "connection" | "command",
    message: string
  ) {
    super(message);
    this.name = "OltVerificationError";
  }
}

export type OntControlAction = "deactivate" | "activate";

/**
 * Distinguishes a safely blocked write from an uncertain device outcome. The
 * route persists this classification so a technician knows whether PuTTY
 * verification is required instead of blindly retrying a command.
 */
export class OltControlError extends OltVerificationError {
  constructor(
    public readonly outcome: "blocked" | "failed" | "uncertain",
    message: string
  ) {
    super("command", message);
    this.name = "OltControlError";
  }
}

function getConnectionSecret(managementIp: string) {
  const raw = process.env.HUAWEI_OLT_CONNECTIONS_JSON?.trim();
  if (!raw) {
    throw new OltVerificationError(
      "configuration",
      "OLT verification is not configured on the NAS yet."
    );
  }

  let parsed: Record<string, OltConnectionSecret>;
  try {
    parsed = JSON.parse(raw) as Record<string, OltConnectionSecret>;
  } catch {
    throw new OltVerificationError(
      "configuration",
      "The NAS OLT connection setting is not valid JSON."
    );
  }

  const secret = parsed[managementIp];
  if (!secret) {
    throw new OltVerificationError(
      "configuration",
      `No OLT connection has been configured for ${managementIp}.`
    );
  }
  if ((secret.protocol ?? "ssh") !== "ssh") {
    throw new OltVerificationError(
      "configuration",
      "This OLT is not configured for SSH verification."
    );
  }
  if (!secret.username?.trim() || !secret.password) {
    throw new OltVerificationError(
      "configuration",
      "The NAS OLT username or password has not been configured."
    );
  }

  const fingerprintText = secret.hostKeySha256?.trim().replace(/^sha256:/i, "");
  let fingerprint: Buffer | null = null;
  if (fingerprintText) {
    const compactHex = fingerprintText.toLowerCase().replace(/:/g, "");
    if (/^[0-9a-f]{64}$/.test(compactHex)) {
      fingerprint = Buffer.from(compactHex, "hex");
    } else if (/^[A-Za-z0-9+/]{43}=?$/.test(fingerprintText)) {
      fingerprint = Buffer.from(fingerprintText, "base64");
    }
  }
  if (process.env.NODE_ENV === "production" && !fingerprint) {
    throw new OltVerificationError(
      "configuration",
      "The OLT SSH host-key fingerprint must be pinned before production verification."
    );
  }
  if (fingerprintText && (!fingerprint || fingerprint.length !== 32)) {
    throw new OltVerificationError(
      "configuration",
      "The OLT host-key fingerprint must be a valid SHA-256 fingerprint."
    );
  }

  const port = secret.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OltVerificationError("configuration", "The OLT SSH port is invalid.");
  }

  return {
    port,
    username: secret.username.trim(),
    password: secret.password,
    fingerprint: fingerprint || null,
  };
}

function verifyHostKey(expectedFingerprint: Buffer | null, key: Buffer | string) {
  if (!expectedFingerprint) return true;
  const actual = createHash("sha256").update(key).digest();
  return (
    actual.length === expectedFingerprint.length &&
    timingSafeEqual(actual, expectedFingerprint)
  );
}

/**
 * Huawei's CLI is interactive rather than a Unix shell. This helper waits for
 * each prompt and automatically advances the read-only display pager.
 */
class HuaweiShell {
  private output = "";
  private pagerSearchFrom = 0;
  private waiting:
    | {
        start: number;
        expectedEcho: string;
        resolve: (value: string) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(private readonly stream: ClientChannel) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.output += chunk;
      if (this.output.length > 2_000_000) {
        this.waiting?.reject(new Error("OLT response exceeded the safe size limit."));
        this.waiting = undefined;
        stream.close();
        return;
      }

      // The pager marker can be divided between SSH packets. Search the full
      // accumulated output from the previous boundary so split markers are
      // still detected, then send one literal space for each new page.
      let markerAt: number;
      while ((markerAt = this.output.indexOf("---- More", this.pagerSearchFrom)) !== -1) {
        this.pagerSearchFrom = markerAt + "---- More".length;
        stream.write(" ");
      }
      this.checkPrompt();
    });
    stream.on("close", () => {
      if (this.waiting) {
        clearTimeout(this.waiting.timer);
        this.waiting.reject(new Error("OLT closed the CLI session."));
        this.waiting = undefined;
      }
    });
  }

  private checkPrompt() {
    if (!this.waiting) return;
    const commandOutput = this.output.slice(this.waiting.start);
    // Old MA5680T software can deliver the previous command's prompt after
    // the next wait begins. Do not accept a prompt until the current command
    // has been echoed back by the OLT.
    if (
      this.waiting.expectedEcho &&
      !commandOutput.toLowerCase().includes(this.waiting.expectedEcho)
    ) {
      return;
    }
    // Examples: MA5680T>, MA5680T#, MA5680T(config)#,
    // MA5680T(config-if-gpon-0/11)#
    if (!/(?:^|[\r\n])[^\r\n]{1,200}[>#]\s*$/.test(commandOutput)) return;
    clearTimeout(this.waiting.timer);
    const { resolve } = this.waiting;
    this.waiting = undefined;
    resolve(commandOutput);
  }

  waitForPrompt(
    timeoutMs = 20_000,
    includeBufferedOutput = false,
    expectedCommand = ""
  ) {
    if (this.waiting) return Promise.reject(new Error("Another OLT command is still running."));
    const start = includeBufferedOutput ? 0 : this.output.length;
    const expectedEcho = expectedCommand.trim().toLowerCase();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new Error("Timed out waiting for the OLT command prompt."));
      }, timeoutMs);
      this.waiting = { start, expectedEcho, resolve, reject, timer };
      // The initial prompt can already be buffered before the shell callback
      // finishes, so its caller opts into checking the existing buffer.
      this.checkPrompt();
    });
  }

  async command(command: string, timeoutMs = 20_000) {
    const response = this.waitForPrompt(timeoutMs, false, command);
    this.stream.write(`${command}\r`);
    return response;
  }

  close() {
    this.stream.end("quit\r");
  }
}

function openHuaweiShell(target: OntVerificationTarget) {
  const secret = getConnectionSecret(target.managementIp);

  return new Promise<{ connection: SshClient; shell: HuaweiShell }>((resolve, reject) => {
    const connection = new Client();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      connection.end();
      reject(
        new OltVerificationError(
          "connection",
          error.message.includes("host key")
            ? "The OLT SSH identity did not match the pinned fingerprint."
            : "Could not establish the secure OLT CLI connection."
        )
      );
    };

    connection
      .on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
        finish(prompts.map(() => secret.password));
      })
      .once("error", fail)
      .once("ready", () => {
        connection.shell(
          { term: "vt100", cols: 160, rows: 60 },
          (error, stream) => {
            if (error) return fail(error);
            settled = true;
            resolve({ connection, shell: new HuaweiShell(stream) });
          }
        );
      })
      .connect({
        host: target.managementIp,
        port: secret.port,
        username: secret.username,
        password: secret.password,
        tryKeyboard: true,
        readyTimeout: 15_000,
        keepaliveInterval: 5_000,
        keepaliveCountMax: 2,
        hostVerifier: (key: Buffer) => verifyHostKey(secret.fingerprint, key),
        // Newport's 2014 DOPRA SSH server offers only the SHA-1 group-exchange
        // KEX and the much weaker fixed 1024-bit group1 KEX. Keep every modern
        // default first, append only the option PuTTY is known to negotiate,
        // and deliberately leave diffie-hellman-group1-sha1 disabled.
        algorithms: {
          kex: {
            append: ["diffie-hellman-group-exchange-sha1"],
            prepend: [],
            remove: [],
          },
          // The same server offers AES/Blowfish/3DES/DES only in CBC mode.
          // Append the AES option and keep the weaker alternatives disabled.
          cipher: {
            append: ["aes128-cbc"],
            prepend: [],
            remove: [],
          },
        },
      } satisfies ConnectConfig);
  });
}

function normalizeCustomerName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

async function enterTargetGponInterface(
  shell: HuaweiShell,
  target: OntVerificationTarget
) {
  const initialPrompt = await shell.waitForPrompt(20_000, true);
  if (initialPrompt.trim().endsWith(">")) await shell.command("enable");
  await shell.command("config");
  await shell.command(`interface gpon ${target.frameNumber}/${target.slotNumber}`);
}

async function readTargetOnt(
  shell: HuaweiShell,
  target: OntVerificationTarget
) {
  const displayOutput = await shell.command(
    `display ont info ${target.ponPortNumber} all`,
    45_000
  );
  const parsed = parseHuaweiOntLog(displayOutput);
  return (
    parsed.onts.find(
      (ont) =>
        ont.frameNumber === target.frameNumber &&
        ont.slotNumber === target.slotNumber &&
        ont.ponPortNumber === target.ponPortNumber &&
        ont.ontId === target.ontId
    ) ?? null
  );
}

function pause(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Read one PON port and return only the requested ONT. No configuration or
 * service-changing command is accepted by this module.
 */
export async function readOntFromOlt(
  target: OntVerificationTarget
): Promise<ParsedOnt | null> {
  const { connection, shell } = await openHuaweiShell(target);
  try {
    await enterTargetGponInterface(shell, target);
    return await readTargetOnt(shell, target);
  } catch (error) {
    if (error instanceof OltVerificationError) throw error;
    throw new OltVerificationError(
      "command",
      "The OLT connected, but its read-only ONT response could not be verified."
    );
  } finally {
    shell.close();
    connection.end();
  }
}

/**
 * Change one ONT's administrative state after re-reading its live identity in
 * the SAME CLI session. The command vocabulary is deliberately closed: no
 * caller-provided text is ever interpolated as a Huawei command.
 */
export async function changeOntActivationState(
  target: OntVerificationTarget,
  identity: { ontSerial: string; customerName: string },
  action: OntControlAction
) {
  const { connection, shell } = await openHuaweiShell(target);
  let writeStarted = false;

  try {
    await enterTargetGponInterface(shell, target);
    const before = await readTargetOnt(shell, target);
    if (!before) {
      throw new OltControlError(
        "blocked",
        "The ONT was not found at the saved location. No command was sent."
      );
    }

    const serialMatches =
      before.ontSerial === identity.ontSerial.trim().toUpperCase();
    const descriptionMatches =
      !!before.description &&
      normalizeCustomerName(before.description) ===
        normalizeCustomerName(identity.customerName);
    if (!serialMatches || !descriptionMatches) {
      throw new OltControlError(
        "blocked",
        "The live ONT identity no longer matches this customer. No command was sent."
      );
    }

    const desiredControlFlag = action === "deactivate" ? "deactivated" : "active";
    if (before.controlFlag === desiredControlFlag) {
      return { changed: false, before, after: before };
    }

    // These are the two and only two state-changing commands accepted by this
    // module. Numeric fields were validated and loaded from PostgreSQL.
    const command = `ont ${action} ${target.ponPortNumber} ${target.ontId}`;
    writeStarted = true;
    await shell.command(command, 30_000);

    // The older MA5680T can acknowledge the write several seconds before its
    // paginated display output reflects the new flag. Retry both stale reads
    // and transient parser/read failures for a bounded period.
    let after: ParsedOnt | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) await pause(1_000);
      try {
        after = await readTargetOnt(shell, target);
        if (after?.controlFlag === desiredControlFlag) break;
      } catch (error) {
        // An incomplete first paginated table can be retried. Connection
        // closure and command timeouts must escape immediately instead of
        // multiplying a 45-second timeout across every retry.
        if (
          !(error instanceof Error) ||
          !error.message.includes("No Huawei ONT status rows")
        ) {
          throw error;
        }
      }
    }

    if (!after || after.controlFlag !== desiredControlFlag) {
      throw new OltControlError(
        "uncertain",
        "The command was sent, but the expected ONT state could not be confirmed. Check the ONT in PuTTY before retrying."
      );
    }

    return { changed: true, before, after };
  } catch (error) {
    if (error instanceof OltControlError) throw error;
    if (error instanceof OltVerificationError) throw error;
    throw new OltControlError(
      writeStarted ? "uncertain" : "failed",
      writeStarted
        ? "The ONT command may have been sent, but its result could not be confirmed. Check PuTTY before retrying."
        : "The ONT could not be checked safely, so no command was sent."
    );
  } finally {
    shell.close();
    connection.end();
  }
}
