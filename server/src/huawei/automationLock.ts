// All unattended Huawei writes and global saves share one PostgreSQL advisory
// lock so a save can never overlap another automatic configuration change.
export const OLT_AUTOMATION_LOCK_ID = 56802026;
