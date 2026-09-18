# Current charges cleared by the September 15 reconciliation

**Investigation and proposal only. No corrective database writes performed.**

Production evidence collected September 15, approximately 13:25–13:32 Jamaica time. Run `preview-current-charge-corrections.sql` for a fresh read-only assessment before any correction.

## Findings

- The original 2,639 ledger credits totaling J$9,467,380 are committed.
- 1,582 accounts had J$4,721,980 cleared against September 5–15 monthly charges whose grace had not ended.
- Customer 7026: September 15 charge posted 00:00:27; waiver posted 01:15:56. A separate reversal at 13:10:41 restored J$5,000. Excluded from proposals. Grace ends September 25; disconnection eligibility begins September 26.
- All 1,582 reviewed accounts were active. These proposals do not change status or reconnection queues.

## Decision totals

| Decision | Accounts | Proposed addition |
|---|---:|---:|
| already_reversed | 1 | J$0.00 |
| covered_by_receipts | 618 | J$0.00 |
| proposed_restore | 933 | J$2,723,330.00 |
| review_due_allocation | 1 | J$0.00 |
| review_later_charges | 2 | J$0.00 |
| review_unlabelled_receipts | 27 | J$0.00 |

## Final verification of the revised proposal

The user-supplied preview matched all original 1,582 classifications and the original J$2,724,330 proposal. The additional ledger-allocation simulation found account **15019** would inherit the wrong grace date, so it is now excluded. Staff review is **30 accounts**, not 29.

The revised **933-account / J$2,723,330** proposal passed a read-only production simulation at **13:40:44 Jamaica time**:

- Zero incorrect due dates or grace dates on resulting unpaid balances.
- Zero additions exceeding the current-charge amount that was cleared.
- Zero simulated unpaid charges on accounts whose resulting balance is nonpositive.
- 56 accounts still have no debt after the proposed correction; later receipts remain credited.
- 46 resulting unpaid accounts have grace ending September 15.
- 76 corrections are partial reversals: J$271,750 of the original relief/credit must be retained. A future apply script must reverse the original waiver and replace its retained portion, or otherwise prevent the original waiver being reversed again in full.

**This verified a proposal, not a database write.** Run the updated preview for fresh balances. The earlier 934-account export is superseded. See `MANUAL-REVIEW-30.md` for the full exclusion list.

## How proposed amounts are calculated

1. Reconstruct the ledger immediately before the original waiver using ledger IDs. Use the application’s oldest-debit-first allocation to find the exact current-charge amount the waiver cleared.
2. Match nonvoid payments already recorded at the waiver to the service month. For due days 1–15, September’s due date represents August service. The proposed addition is the smaller of the amount cleared and the monthly charge less matching payments, never below zero.
3. Add that amount to the current ledger balance. Later payment credits remain in place; they are not subtracted a second time. Existing future credit is not separately reversed.
4. Exclude an already reversed waiver. Hold unlabelled receipts, changed schedules/status, and subsequent charges or manual adjustments for separate review.

**Limitations:** payment month labels and historical ledger records may be incorrect. These are conservative proposals under the corrected rule, not proof of the underlying service obligation. Receipts without month labels collected before August 1 are outside this receipt extract. Their recorded ledger credit is included in the allocation, but unrecorded advance coverage cannot be established from this scan.

## Separate issues

Accounts 2525, 9524 and 9946 have older monthly charges generated after the reconciliation when payments were entered. They are excluded from automatic proposals (9524 is also in the unlabelled-receipt group). Review the payment-month charge generation path before deciding whether those older charges are valid.

Restoring charges with grace ending September 15 could make unpaid accounts eligible for disconnection September 16. Any application must preview the resulting billing eligibility, use employee 2, and be guarded against repeat execution and payments/reversals arriving after review. Do not rerun the original reconciliation.

## Customer detail

| ID | Customer | Due | Grace ends | Decision | Current balance | Proposed addition | Proposed balance |
|---|---|---|---|---|---:|---:|---:|
| 19 | Rosemarie Bennett | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 23 | Everton Russell | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 36 | Floydeen Morgan | 2026-09-07 | 2026-09-17 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 38 | Jennifer Williams | 2026-09-09 | 2026-09-19 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 50 | Patra Bolton | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 51 | Isolyn Daley-Daleys Grove | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 56 | Arlene Knight | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 63 | Lavern Hepburn | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 90 | Tyrone Daley | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 103 | Samora Tate | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 126 | Steve Thompson | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 130 | Celia Halcolm | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 161 | Kamoya Gordon | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 179 | Janice Bryan/Levor Williams | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 187 | Gloria Thompson Smith | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 190 | Vanessa Oldacre | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 192 | Vivienne Mowatt | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 193 | Tesha Dennis | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 196 | Shadona Gordon | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 198 | Rose Tomlinson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 199 | David Dawkins | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 201 | Otis Griffiths | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 212 | Antoinette Gordon | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 220 | Latoya Nicholas | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 226 | Dawn Lewis | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 229 | Richard Williamson | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 239 | Veronica Peart Johnson | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 242 | Claudia Dunn | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 247 | KIMBERLY SWABY | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 249 | AUDREY MITCHELL | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 250 | Jean Surf | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 264 | Natalie Legg | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 265 | Chantelle Dixon | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 289 | Natasha Dunn | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 293 | Sandra Coluqhoun | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 309 | Oral Porter | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 325 | Jermaine Kitson | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 327 | Shanni Johnson | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 365 | Kaydie Beezer | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 367 | Christ Cathedral Community | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 368 | Prince Beckett | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 370 | Loletta Davidson | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 373 | Charlene Campbell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 396 | Michelle Bolton | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 408 | Marjarie Whyte Wilks | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 426 | Beverley Smikle | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 444 | Garfield Morgan | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 448 | Rosemarie Thompson Collins | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 450 | Demar Daley | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 454 | James Sconce | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 459 | Aldeen Snaith | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 463 | Stacey Ann Baker | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 488 | Kerry Ann Dixon Brissett | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 517 | Shadene Smith | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 525 | Kemar Levy | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 526 | Stacey Ann Thompson | 2026-09-13 | 2026-09-23 | proposed_restore | -5,000.00 | 5,000.00 | 0.00 |
| 529 | Leonard Anderson | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 531 | Karl Channer | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 582 | Evelyn Stephenson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 588 | Karian Janice Woodburn | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 589 | Sasha Grant | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 592 | Melonie Knight | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 602 | Melody/Conrad Facey | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 605 | Delores Clarke | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 636 | Joseph Ellington | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 637 | Desmond Crawford | 2026-09-05 | 2026-09-15 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 651 | Robert/ Hillary Wright | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 655 | Duane Campbell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 678 | Ashton Taylor | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 699 | Mitchel Pitter | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 700 | Andrea Teape | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 702 | Rose Ann Morgan Richards | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 737 | Karol Whims | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 738 | Phillip Smith | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 739 | Alisia Burton | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 740 | Curtis Davy | 2026-09-15 | 2026-09-25 | proposed_restore | -2,000.00 | 3,000.00 | 1,000.00 |
| 742 | Tisha Powell | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 744 | Clasburk Manning | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 749 | Lorna Bolton | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 752 | Travis Swaby | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 784 | Sonji Levy/ Natalia Levy | 2026-09-07 | 2026-09-17 | covered_by_receipts | -500.00 | 0.00 | -500.00 |
| 792 | Nadeen Williamson | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 796 | Astley Atkinson | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 804 | Andrea Manning | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 807 | Garfield Martin | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 809 | Ransford Richards | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 811 | Gayre Christian | 2026-09-12 | 2026-09-22 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 812 | Elsworth Dixon | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 813 | Albion Works Limited (master block) | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 855 | Vernice Campbell | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 856 | Timmo Bartley | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 862 | Claudette Myers Christian | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 865 | Swayne Reid | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 868 | Stacy-Ann Carridice | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 886 | Nakeisha Edwards | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 920 | Dianne Atkinson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 921 | Shana Lee Cerfe | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 925 | Asneth Frazer | 2026-09-10 | 2026-09-20 | covered_by_receipts | -4,000.00 | 0.00 | -4,000.00 |
| 926 | Marcia Matthews | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 928 | Lollymae Samuels | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 931 | Orvil Lynch | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 933 | Shanae Sergant | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 934 | Elizabeth wright | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 935 | Latoya Simpson | 2026-09-12 | 2026-09-22 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 938 | Kemoy Reid | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 939 | Denise Morgan | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 940 | Neisha Rowe | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 959 | Pauline Maxwell | 2026-09-12 | 2026-09-22 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 972 | Oliver Johnson (Blenhiem Town) | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 996 | Alvin Frater | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 997 | Jerry Robinson | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 999 | Michael Edwards 2 | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1001 | Veron Campbell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1002 | Marcia Francis Pinnock | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1049 | Nodeen Brooks Maxwell | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1069 | Kedesiah Morgan | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1073 | Ryon Marshall | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1078 | Kaydon Blackwood | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1079 | Careen Brown | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1084 | Nichole Smith Dixon | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1086 | Leroy Smith 1 | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1088 | Halford Davy | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1089 | Venora Farquharson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1090 | Howard Augustus Derizzio | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1091 | Majorie Morrison | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 1093 | Audrey Giscombe | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 1098 | Lilia Christian | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1101 | Akeem Smith | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1103 | Junior Williams | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1106 | Stacey Ann Mcpherson | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1108 | Shauna Rose | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 1109 | Craig Mccatty | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1114 | Mary Ricketts | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1115 | Roger Bowen | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1116 | Brenda McCatty | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1117 | Anika Powell | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1122 | Sonya Thompson | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 1,600.00 | 1,600.00 |
| 1123 | Marsha Vassell Reid | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1124 | Harris Brown | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1223 | Faithlyn Holness | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1234 | Sona Mitchell | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1242 | Kenrick Maxwell | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1245 | Phyllis/ David Bartley | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 1247 | Goldie Barrett | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1248 | Juid Ann Clarke Meggie | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1252 | Rose Marie Pinnock | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1254 | Tanya Morgan | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1255 | Chevis Francis/Conroy Francis | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 6,500.00 | 6,500.00 |
| 1257 | Marvin Wilson | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1259 | Donnette Thompson | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1261 | Donnette Morgan Saphrey | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1262 | Heather Mullings | 2026-09-10 | 2026-09-20 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 1263 | Melesia Miller | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1265 | Marlene Forbes | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1271 | Kerry Ann L.Burrell | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1272 | Tricia Pryce | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1274 | Lancaster Emmanuel Apostolic Church | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1275 | Shellan Henry | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 1277 | Leo Rose | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1282 | Megan Wheatle | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1294 | Monique Thompson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1306 | Kayon Pinnock | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1307 | Ricardo Mcnally | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1387 | Delan Forbes | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 8,500.00 | 8,500.00 |
| 1388 | Prince Myers | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1394 | Ransford Matthews | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 1396 | Nadine Rhoden | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1401 | Kerry Ann Reynolds | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1404 | Monique Witter | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1410 | Zornette Hepburn | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1414 | Tajuana Rattray | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1417 | Collette Allen Morgan | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1422 | Nathalee Watson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1423 | Venisa Newell | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1425 | Everald Thomas | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 1426 | Paulette Meade | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1427 | Tameika Swaby Johnson | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1428 | Mark Dixon | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1429 | Keith Easy | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1432 | Veun Ashman Powell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1434 | Kerry Ann Foster Haughton | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1435 | Patrick Wright | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 1515 | Everdeen Stobbs | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1518 | Howard Lewis | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1522 | Stephen Allerdyce | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1525 | Marvia Sharpe | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1526 | Delores Forbes | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1527 | Annette Morgan | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1530 | Carla Biggs Watson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1531 | Keron Golding | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1532 | Jacqueline Whilby | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1533 | Sharon Martin | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 1534 | Jasseth Williams | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1535 | Mildred Preddie | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1536 | Darian Dussard | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1539 | Chennel Cowan | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1540 | Ivarine Morgan | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1541 | Kimone Brooks | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1543 | Lorna E Morgan | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1545 | Marie Campbell | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1546 | Vivica Mcnally | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1621 | Casan Young | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1622 | Anne Davidson | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1624 | Carleen Blidgen Stewart | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1627 | Leon Crawford | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1632 | Clarence Wood | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1640 | Carlene Green | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 1641 | Fiona Morris | 2026-09-11 | 2026-09-21 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 1645 | Peter Wright | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1646 | Carolyn Wright | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1651 | annmarie plummer | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 1653 | Isaiah Facey | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1655 | Stephanie Kennedy | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1657 | Nadesha/Lucan Thompson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1659 | Taniesha Pryce Gilpin | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1662 | Alton Anderson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1666 | Franklyn Brown | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1668 | Andrea Bartley Hackshaw | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1672 | Jerome Swaby | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1673 | Travis Philpotts | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1678 | Merlene Edwards | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1679 | Keela Pinnock-Hartley | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1680 | Latoya Hewitt | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1686 | Earl West | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1750 | Shannette Manning Forbes | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1751 | Paul Morgan | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 1756 | Viviene Lindo | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1757 | Hervine Gibbons | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1768 | Dayvia Sturn | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1769 | Sharon Dunn | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1770 | Quacina Lee | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1776 | Aneika Daley | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1780 | Collette Lewis Downie | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1782 | Jaun Cheree Thompson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1789 | Adelza Smith | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1793 | Dave Meikle | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1799 | Donald Edwards | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1800 | Richard Turner | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1803 | Natesha Crawford | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1804 | Stacey Holness | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1832 | Christopher Lawe | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1864 | Elaine Mcnally Reid | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1870 | Stacy-ann Bartley | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1873 | Marsha Newell/ Woolton Hylton | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1877 | Bethabara Moravian Church (Manse) | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 1878 | Kenisha Doodnaughtsingh | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1880 | Dwayne Daley-Shop | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1881 | Randall Thompson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1886 | Meleta Narcisse | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1887 | karene Stultz | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 1888 | Sheryl Miller | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 1890 | Calvin Robinson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 1892 | Wainey Daye | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1895 | Tiffany Williams | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 1899 | Fiona Smith | 2026-09-12 | 2026-09-22 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 1905 | Kadene Wright | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2025 | Delroy Pinnock | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 2034 | Felicia Anson-Rose Hill | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2037 | Orville Morrison | 2026-09-08 | 2026-09-18 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 2038 | Melissa Samuels | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2039 | Prestley Brown | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,600.00 | 2,600.00 |
| 2046 | Francine Grant-Lewis | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2052 | Chavernice Johnson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2053 | Klaion Holness | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2054 | Keisha Swaby | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 2055 | Taniesia Easy | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2056 | Demar Bailey | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2057 | Mellisa Blake | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2059 | Ludesha Simpson | 2026-09-14 | 2026-09-24 | covered_by_receipts | -500.00 | 0.00 | -500.00 |
| 2062 | Dexter Thompson | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2063 | Taslea Bryan James | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2104 | Taceanne Francis | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2105 | Shaine Thetford | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2113 | Donox Adams | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2122 | Karen Smith Miller | 2026-09-15 | 2026-09-25 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 2129 | Doreen D. Shephard | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2130 | Althea Richards | 2026-09-11 | 2026-09-21 | covered_by_receipts | -1,200.00 | 0.00 | -1,200.00 |
| 2131 | Richard Bryan | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2134 | Rema Williamson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2139 | Sunlin Morgan | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2140 | Stacy-Ann Arkins | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 2144 | Keith Anderson | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2146 | Lorna West | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2148 | Ann Simpson | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2152 | Curtis Grindley | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 2153 | Ezra Reynolds | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2155 | Shay Ann Johnson Carter | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 2158 | Kevin Davy 2 | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2261 | Dicoda Davidson | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2269 | Anthony Wright | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2270 | Floyd Smith | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 2275 | Carline Ashman | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2277 | Kinodeen delmas Morgan | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2281 | Marvaley mccatty Brown | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2283 | Shannett Mullings-Gordon | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 2285 | Janet Powell Gordon | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 2286 | Marcia Lawe | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2288 | Yvonne Barrett | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2289 | Pearl Hogg | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2290 | Richard Delano Ward | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 2291 | Shelly Ann Richards | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2293 | Angella Anthony | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2294 | Shellyann Mahon | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2295 | Damion Channer | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 2297 | Jacqueline Loney | 2026-09-14 | 2026-09-24 | proposed_restore | -2,500.00 | 4,500.00 | 2,000.00 |
| 2299 | Phillip Morris | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2301 | Jennese Haughton | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2368 | carol hines | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2372 | Basil Brown | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2418 | Shawna gay Christie | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2427 | Tricia Edwards | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2434 | Judith Maitland | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2443 | Amy Dixon | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2446 | Nisha Richards | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2448 | Shanakay Kentish | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2489 | Jeff Rowe | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2501 | Karlene Hall | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 7,500.00 | 7,500.00 |
| 2503 | Davia white | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2508 | Danielle Mlaughlin | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2512 | Venris Morgan | 2026-09-08 | 2026-09-18 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 2514 | Sharon Mullings | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2518 | Sandra Lee | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2520 | Venessa Clarke | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 2521 | Karen Morgan | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2522 | Jerome walters | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 2525 | Le-Ann Swaby | 2026-09-09 | 2026-09-19 | review_later_charges | 500.00 | 0.00 | 500.00 |
| 2527 | Shannon Grant | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2536 | Conroy Dixon | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2537 | Taj-marie Whyte | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 2540 | Deneshia Williams | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2541 | Merrick Henry | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 2542 | Chad Gordon | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2544 | Eudel Anderson | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2545 | Isiah W Reid | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2546 | Frederick Bryan | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2547 | Shaniel Brown | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2550 | Camelia Fisher | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,450.00 | 2,450.00 |
| 2552 | Odette Wright | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2557 | Narda Bailey | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2562 | Arnella Thomas | 2026-09-14 | 2026-09-24 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 2566 | Marvin Brissett | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2577 | Richardo Hendricks | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2661 | Keith Brooks | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2662 | Shelly Ann Brooks | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2665 | Kerrian Goulbourne | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2666 | Nicola Elliot | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2668 | Evelyn Bent | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2681 | Shernet T Wilson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2684 | Trishan Morgan-Ellis | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2686 | David Jones | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2690 | Kerry ann Reynolds 2 | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 2692 | Mc Neish Carroll | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2698 | Peta gaye Pinnock | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2699 | Natasha Kennedy | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2795 | Monique Marshall | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2800 | Tyreese Smith | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 2805 | Catherine C. James | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2826 | Dwayne Crawford | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2827 | Clifton Williams | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2907 | Doreen Walker | 2026-09-06 | 2026-09-16 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 2909 | Barbara Harris | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 2912 | Sanya Burns | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2913 | Antonette Blake | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2914 | Daneika Smith | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2915 | Advella L Meikle | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2917 | Letecia Wilmoth | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 2927 | Kerry Ann West | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2930 | Nicholene Daley | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2931 | Kenroy Nelson | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 2933 | Christine Mahabeer | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2939 | Simone Chisholm | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 2940 | Shahira Thompson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 2941 | Tamara Robinson Gowan | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2942 | Courtney Morgan | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2943 | Margaret Lewis | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 2946 | Kayann Lee | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2957 | Barrington Bailey | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 2962 | Sheena Powell | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 3112 | Greta Reid | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3121 | Ashly Barrett | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3124 | Lance James | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3125 | Carlan Mullings | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3126 | Jessicka Thompson | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 3128 | Lisa Beckford Brown | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3131 | Eliese Ashman#1 | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3134 | Dorothy Turner | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3137 | Winston Smith | 2026-09-12 | 2026-09-22 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 3138 | Andre Rowe | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3139 | Jerome Hanson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 3140 | Samishia Ellington | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3141 | Dwight A Hines | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3142 | Andrew Moore | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 7,500.00 | 7,500.00 |
| 3148 | Ianto Edwards | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3150 | Kalbert Williams | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3151 | kemeisha Morgan | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3154 | Marsha Peart | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3155 | Cynovia Hudson Elliott | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3164 | Hughroy Miller | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3233 | Hector Hanson | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 3235 | Mickayla Pitter | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 3237 | Velma Taylor Laidlaw | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3246 | Carrie Powell-Pitter | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3251 | Jordia Pitter | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3252 | Simone Francis Crawford | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 3255 | Janet Reid | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3257 | Renee Jackson | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3260 | Lesiah Roach | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3264 | Najwa Blackwood -Dougal | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 3275 | Marsha Ann Thomas | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3288 | Donna Morgan | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3294 | Eliese Ashman#2 | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 3302 | Carl Givans | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3305 | Elizabeth Brooks | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 3307 | Jacquline Nunes- Miller | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3309 | Peaches Allen | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3311 | Shudine Green | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 6,000.00 | 6,000.00 |
| 3312 | Charmaine Green | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3313 | Mayalee Laidlaw | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3314 | Radcliff Edmond | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3315 | Andrea Green | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3318 | Sophia Lamie | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3321 | Cassandra Powell-Reid | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3330 | Peter-gaye White | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 3341 | Jerry Gooden | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3342 | Shanalee Cassells | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3543 | Shaquille Anthony Wright | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3545 | Michelle Pitter Stevens | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3552 | Natalia Bradford | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 3553 | Shameika Henry | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 3555 | Zoddian Bowen | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 3559 | Andre Smith | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3570 | Natisha Smith-Gayle | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3571 | Janet Stultz | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 3575 | Lavender Mckenzie | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3580 | Orville E Chung | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3581 | Aloine Powell | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3583 | Gillian Brooks Jones | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 3593 | Tanesha A.Smith | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3613 | Neasia Senior | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3615 | Eric Junior Mclean | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3620 | Natassia Williamson | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 3622 | Sharon Blake | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3627 | Marilyn Trew | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3630 | Winnifred Ingram | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3633 | Shernette Brown | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3634 | Latoya Hanson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3635 | Ronique Williams | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3636 | Lisa Benjamin | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3637 | Sonya -Gaye Dixon | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3638 | Sandra Albert | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3639 | Rochelle James | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 3640 | Kadia Baker | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3643 | Natisha Nelson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 3644 | Mauline D Williams | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 3651 | Stacey Beckford | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3656 | Francene Gordon | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3657 | Jason Hanson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3659 | Lissa Anderson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3663 | Richard Bird | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3664 | Mexcior Graham | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3666 | Chad Davy | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 3667 | Jasmine Ann Mcleod | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3670 | Marcus Pusey | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3848 | Stacy Ann Ellison | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3849 | Sanika Clarke | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3879 | Senorita Thompson Brown | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3881 | Kirk Charley | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3883 | Tenecia Allen | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3886 | Renique Witter | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 3893 | Angella Stewart | 2026-09-13 | 2026-09-23 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 3895 | Nicola M Robinson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3897 | Durine Powell Dunn | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3900 | Kemian Gayle Thomas | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3904 | Melissa Williams | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 3908 | Tosmo Ward | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 3919 | Tracy Ann Avans | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4074 | Emesha Millings-Davey | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4076 | Debbie Daley | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4080 | Ritta Evans Lowe | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 4087 | Stacy-Ann Isaacs | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4090 | Anchardo Hewitt | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4093 | Odeon Walters | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4095 | Nickisha Wint | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 4100 | Ian Hislop | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4103 | Jennifer Munroe | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4112 | Robert Walker | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 4113 | Peter Williams | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4115 | Dorothy Smith #2 | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4116 | Devon Smith | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4117 | Yasheka Hynes | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4118 | Tracey-Ann Lee | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 4119 | Steve Anthony Powell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4120 | Dorien Allen | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4124 | Jermaine Simpson | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4127 | Hopeton/Sarah Hewitt | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 1,250.00 | 1,250.00 |
| 4128 | Joy Adamson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4150 | Jodi-Ann Scafe | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4225 | Susan Lawrence | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4255 | Marcia Williams | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4259 | Taniece Taylor | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 4262 | Gwendolyn Robinson | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4265 | Neil Barrett | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4266 | Shanel Graham | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4268 | Sonya-Jo Buser | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4269 | Mark Crawford | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 4270 | Karl Mayne | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4274 | Alvin Swaby | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 4278 | Shantal Hall | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 4295 | Donovan Jones | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 4304 | Keisha Nicola Morgan | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4307 | Garfield Preddie | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4316 | Darnalee Scille | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 4317 | Samantha Smith-Farm | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 4319 | Kayonn Thompson | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4345 | Pauline Walters Orvil lynch | 2026-09-12 | 2026-09-22 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 4347 | Marlon N Williams | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4349 | Khalica Fuller | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4353 | Juline Tanasha Powell | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4360 | Cecil Gayle | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4363 | Lucille Campbell | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4365 | Natalie Spence Wright | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4368 | Antonio Anson | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 4374 | Tallejae Flemmings | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 1,300.00 | 1,300.00 |
| 4377 | Winnifred Hanson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4379 | Everton Thomas | 2026-09-15 | 2026-09-25 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 4451 | Ohen Johnson | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4453 | Kerecia Francis | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4463 | Abbedayle Samuels | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4469 | Mashaun Stephens | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4471 | Tenisha Clarke | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4481 | Rohan Dixon | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4489 | Marcelene Chambers | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 4491 | Elsworth Bailey | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4504 | Lettuce Davey | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4510 | Oneil Patterson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4511 | Herman Green | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4583 | Alpheus Mclean | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4589 | Affricka Smith Ricketts | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 4592 | David Lloyd White | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4597 | Shelly-Ann Peart | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4616 | Jadon Stewart | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4618 | Kenrick Burton | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4621 | Richard Baker | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4624 | Roy Mitchell | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 4625 | Rayon Thompson | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4626 | Ainsley Baker | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 4630 | Gifford Edwards | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4702 | Kay Parker | 2026-09-05 | 2026-09-15 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 4714 | Suzette Bryan | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4718 | Michelle Lewis | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4721 | Chadwick Easie | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 4726 | Joudian Phillips | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4732 | Earnel Rowe | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4737 | Natetia Natalie Farquharson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4740 | Curtis Grindley 1 | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 4748 | Kemisha Adams | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 4752 | Jennifer Smith | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4753 | Kathleen Coley | 2026-09-10 | 2026-09-20 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 4754 | Lenford L.Watson | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4758 | NCU PRESS | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4762 | Faith Emmanuel Apostolic Church | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4892 | Judith Beckford | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 4911 | Dwayne Glave | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 4913 | Natalee Gordon-Henry | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4928 | Dahvone Dontae Simpson | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4942 | Delores Nelson | 2026-09-06 | 2026-09-16 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 4950 | Oshane Darby#2 | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4958 | Dorris Campbell | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4964 | Kelly Ann Gordon-Edwards | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 4972 | Keneil  George Edwards | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4978 | Angella Mitchell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 4979 | Dujon McDonald | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5014 | Patricia Palmer Powell | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5036 | Courtney Francis | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 5041 | Trae Devon Thompson | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5044 | Sangine Robinson | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 5045 | Monique Mardner Edwards | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5046 | Kenrick Morgan | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5066 | Shevan David Roache-Shop | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5073 | Shantay McLean | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5075 | Joy White | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5121 | Pauline Wheatle Fletcher | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5152 | Ricardo Coley | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5158 | Vendolyn Matthews | 2026-09-10 | 2026-09-20 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 5171 | Carmeleta Orenthia Smith | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5175 | Blanche Watson | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5191 | Kareen Reid | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5194 | Verna Henry | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 5237 | Roxanne Brown | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,400.00 | 2,400.00 |
| 5287 | Lockley Cassanova | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 5288 | EVERALD DOBSON | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5289 | Alderene Roye | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 7,500.00 | 7,500.00 |
| 5292 | Andrew Raymond | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5310 | Amoy Sharpe forrester | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5312 | Junior Griffiths | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 5327 | Nickoy Chin | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5330 | Leon Hickling | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 8,500.00 | 8,500.00 |
| 5337 | Chester Reid | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5352 | Maizilyn Allen | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5353 | Adeline J Buchanan | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5371 | Dorrett Elliott | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5379 | Janice Smith | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5382 | Renae Mclaughlin-Newfield | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5383 | Juliet Morgan | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5384 | Gregory Anderson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5386 | Arlene Edmund | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5390 | Karen Smith (Hillside) | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5393 | Douglas Gardner | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5396 | Samantha Boothe | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5404 | Conrad Walter | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5405 | Marcia T Williams | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 5413 | Paulette Taylor | 2026-09-15 | 2026-09-25 | covered_by_receipts | -250.00 | 0.00 | -250.00 |
| 5432 | Schevanniese Brown | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5433 | Faith Smith | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5442 | Asheka Myers | 2026-09-15 | 2026-09-25 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 5447 | Sharlet Forbes | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5454 | Ethelstan Mcleod | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5455 | Ann-Marie Mcfarlane | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5460 | Eileen Foster | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5465 | Doreen Shakespare | 2026-09-07 | 2026-09-17 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 5479 | Richardo Williamson | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5484 | Brenton Richards | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 5485 | Ivan Blackwood | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5489 | Sasha Gay Palmer | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5491 | Sannette Young | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5492 | Debbie Campbell-Cogle | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5495 | Javion Sappleton | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5504 | Ruthan Smile Biggs | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5506 | Felecia Wynter/Omar Green | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 5512 | Donna Ellis Clones | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5533 | Cameica Henry | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 5535 | Pauline Jackson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5539 | Shaday Levy | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5540 | Clyde Simpson Spur Tree | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5550 | Juli-ann Bennett | 2026-09-15 | 2026-09-25 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 5557 | Desrine Mitchell | 2026-09-09 | 2026-09-19 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 5569 | Trecia Brown | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5575 | Gregory Nesbeth | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 5591 | Chantoll Cerfe | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5599 | Carl Miller | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5616 | Odane Forbes | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 5622 | Richard Malcolm Berry Hill | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5632 | Damion Williamson | 2026-09-11 | 2026-09-21 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 5643 | Veronica A Cassells | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5647 | Tamara Barrett-Longmore | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5666 | Mauva Swaby-Top Hill | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5667 | Leroy Roland | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5675 | Seymour Findley | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5680 | Theresa Smith | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5681 | Lascelles Morgan | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5683 | Howard Williams | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5717 | Leon Burrell | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 5718 | Samantha Mundle | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5765 | Carlington Smith | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 5770 | Cynthia Davey | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5776 | Keion Edwards | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5789 | Eric Richards | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 5797 | Gilbert White | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5799 | Dondre Campbell | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5801 | Fergene Hall | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5806 | Dalia Johnson | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5818 | Sylvia Morris-Jones | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5824 | Marlon Russell | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,700.00 | 3,700.00 |
| 5828 | Tracyann Folkes | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5829 | Shemar Levy | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 5835 | Richard Wright | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5838 | Mawangie Samms | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 5869 | Bryan Taylor | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5884 | Jessica Williams | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5901 | Damain Blackwood | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5903 | Horace Thompson | 2026-09-09 | 2026-09-19 | covered_by_receipts | -4,000.00 | 0.00 | -4,000.00 |
| 5905 | Horace I Clarke | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 5918 | Tamare Wright | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5932 | Dwight Allen | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5940 | Amoy Reid | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 5943 | Juliet Brooks | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5944 | Ricardo Whyte | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5950 | Letisha Robinson | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5956 | Christopher Johnson | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 5957 | Winsome Hinds | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 5992 | Curtis Powell | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 5995 | Chester K Daley | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6039 | Denville Malcolm | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6050 | Letecia Francis-Hewitt | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6055 | Oneil Dixon | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6070 | CHAKERA ROBINSON | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6081 | Linda Thompson | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6087 | Pelocka Binns | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6090 | Maxine Evans | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 6101 | Lysinda Alberts | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6127 | Weston Thompson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6129 | Carolyn Grant | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6134 | Clifton Golding | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6142 | Tracy Lewis | 2026-09-10 | 2026-09-20 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 6147 | Kerryann Bryce | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6190 | Edward Morgan | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6209 | Hyacinth Gayle | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6229 | Althea Broomfield-Beckford | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6246 | Vergenia Wright | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6250 | Gladston Hall | 2026-09-08 | 2026-09-18 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 6252 | Conray Wright | 2026-09-06 | 2026-09-16 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 6268 | JANET HALL ROBINSON | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6271 | Shandeana Benjamin | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6273 | Roger Walters | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6275 | Leonie Morgan | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6277 | Marion Ford | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6279 | Carlene Bailey Elvy | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6280 | Stephanie Mitchell | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6282 | Sherri Ann Morgan | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6284 | HERMINE GAVIN | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 6298 | DESORENE TAIT Ballynure | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 6329 | Steve Heron | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6331 | Paulette Simpson\Encle Simpson | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6333 | Lily Thomas | 2026-09-14 | 2026-09-24 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 6334 | Natoya Bartley | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 6339 | Donna Alexander-McIntosh | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6350 | Angelee Preddie | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6354 | Adrian Broomfield | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6367 | Cross Keys Branch Library | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 6370 | David Johnson | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6371 | Courtney Foster | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6374 | Jennifer Francis | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6377 | Kizzy Brown | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6381 | Cherry Ann Brown | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6387 | Joel Boothe | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 6388 | Abbagail Powell | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6390 | Daneile Brown | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 6392 | Linel Melvin | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6393 | Lenford Plummer | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6396 | Florezel Farquharson | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6398 | Camile Pusey | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6401 | Deryck Douglas | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 6402 | George Thompson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6417 | Latoya Scarlett | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 6419 | Lola Wright-May Day | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6441 | Movetta Garwood | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6460 | Beverley Dixon | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 6481 | Linda Mannings | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6484 | Abigail Lewis | 2026-09-05 | 2026-09-15 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 6498 | Deneisha Gregory Blake | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6507 | Tasha Young | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6517 | Jacqueline Thompson | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6520 | Judith Barrett Lewis | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 6521 | Travis Williams | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6522 | Keron Graham | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 6523 | Radrief Blake | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6525 | Joseph Edmund | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6526 | Machel Stephens | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6527 | Antwan Newman | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6534 | Joycelin Brown | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6557 | Randy Mitchell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6559 | Tashiena Smith | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6560 | Marlon Daley | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6609 | Nadine Ranger | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 6617 | Lloyd Wynter | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6638 | Lavern Spencer | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6639 | Janet Scafe | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6641 | Winsome Hall Green Pond | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6643 | Marlon Lewis | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6648 | Rusheen S Hylton | 2026-09-09 | 2026-09-19 | covered_by_receipts | -1,500.00 | 0.00 | -1,500.00 |
| 6650 | Latoya Douglas Spur Tree | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6658 | Mary Smith | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6659 | Verona Brown | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6668 | Salome Allen | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6696 | Dwayne Green | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6713 | Shanique Thomas | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6747 | Marva Morgan | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6755 | Renae Reid-Ballynure | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6756 | Clarence Graham | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6766 | Sharnele Samuels | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6793 | Renea Auld | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 6840 | Shelly-Ann Mcfarlane | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6842 | Cynthia Binger/Desrene Smith | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,450.00 | 2,450.00 |
| 6861 | Cross Keys New Testament Church | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6866 | Anneisha Walters | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6872 | Beverley Brown-Trelawny | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 6874 | Gilbert Granston | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6878 | Marjory Powell/Aston Powell | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 6881 | Roland Edmond | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6887 | Adriana Daley | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6888 | Jody-Ann Bryan | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6889 | Dotline Clarke | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6891 | Tenesha Sterling | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6895 | Fiona Turner | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6900 | Natoya Glave | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6901 | Suwayne Hewitt | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 6913 | Nigel Smith | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6926 | Nahiesha Baker | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6927 | Tyrone Lewis | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6959 | Curdel Lewis | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6967 | Ruben Wright | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 6970 | Chyke Stewart | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 6975 | Lenroy Burnett | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7009 | Georgetta Williams | 2026-09-09 | 2026-09-19 | proposed_restore | -3,500.00 | 3,500.00 | 0.00 |
| 7012 | Dornina Gregory | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7013 | Jodi-kaye Blackwood | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7015 | Carlton Windett | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7026 | Nickesha Nelson Robinson | 2026-09-15 | 2026-09-25 | already_reversed | 5,000.00 | 0.00 | 5,000.00 |
| 7030 | Nefrita Powell | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7057 | Marsha-Gay Campbell | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7058 | Lamoy Knott | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7076 | Janice Preddie | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7090 | Lisagay Thompson | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 7094 | Alanzo Allen | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7115 | Jennifer Kenley | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7120 | Toni-Ann Baker Johnson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7128 | Tyrellea Simms | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7129 | Pamella Givans#2 | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7130 | Carlton Brown | 2026-09-15 | 2026-09-25 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 7133 | Christine Owen | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7134 | Shanice Rowe | 2026-09-06 | 2026-09-16 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 7137 | Natalya Barrett | 2026-09-15 | 2026-09-25 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 7138 | Lorna Stine | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7140 | Rushell Shaw | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7149 | Abigail Lewis #2 | 2026-09-05 | 2026-09-15 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 7150 | Glenroy Dyer | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7151 | Marion Chantilope | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7153 | Maureen Whitley | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7156 | Maxine Samuels Baker | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7157 | Carlene Doreen Leonards | 2026-09-07 | 2026-09-17 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 7158 | Julian M Miller | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7337 | Ruth Ann Mckenzie | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7358 | Hyacinth Mead | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7361 | Melesha Dixon | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7381 | Sandra Adamson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7382 | Ateeno Francis | 2026-09-13 | 2026-09-23 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 7387 | Janet Gavin | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7440 | Peter-gaye White #2 | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7444 | Verona Miller | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7446 | Ann Marie Knight RB Street | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7461 | Serica Stewart | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7463 | Marvia Givans | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7469 | Saushaine Taylor #2 | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7473 | Desrene Mullings | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7481 | Deon Davidson | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7494 | Bernadine Swaby | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7495 | Juven Plummer | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7516 | Peter-Gay Ross | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7525 | Jermaine Royal | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7528 | Kaydeon Bennett-Francis | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7529 | Rosheda Lindsay | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7544 | Cassandra Bell | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7546 | Vinnetta Vassell | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 7547 | Romae Thorpe | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7562 | Charles Benbow | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7567 | Wayne Bennett | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7572 | Ralton Williams | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7803 | Alexander George Thompson | 2026-09-14 | 2026-09-24 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 7804 | Venris Morgan#2 | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7815 | George Lewis | 2026-09-13 | 2026-09-23 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 7836 | Dwayne Turner/Romola Ryal Turner | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 7848 | Yvonne Shields | 2026-09-06 | 2026-09-16 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 7872 | Tremaine Gracey | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 7882 | Christene Bradford-Longsyne | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 7884 | Enid White | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7891 | Neva Brown | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 7924 | Sachin Thompson | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7927 | Veronica Morris | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 7930 | Stanford Chambers/Nadia Samuels | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 7941 | Tashera Cohen/Shamar Frome | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8003 | Samantha Coley | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 10,000.00 | 10,000.00 |
| 8016 | Demar Dailey John Rock | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8017 | Max Walker | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8018 | Shinelee Williams | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8019 | Daniel Watson | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8021 | Carlton Mcdaniel | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8023 | Ransford Edwards | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 750.00 | 750.00 |
| 8037 | Serri-Ann Anglin | 2026-09-15 | 2026-09-25 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 8040 | Nicole Davis | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 8050 | Lorraine Elizabeth Williams | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8055 | Verna Blake | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8061 | Denise Tobias | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8192 | Tajay Reid | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8215 | Anthony Goulbourne | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8216 | Kavaughn Bennett | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8219 | Barbara Biggs Brown | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8228 | Adrian Brown | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8229 | Javane White #2 | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8232 | Novelette Buddah | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8236 | Paul Thomas | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8239 | Harvena Ayre | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8243 | Charmaine Morias Bedward | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8244 | Ian Davis | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8253 | Dexter Williams-Newport | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8256 | Rohan Morgan | 2026-09-12 | 2026-09-22 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 8258 | Galda Bennett | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 8260 | Chelton Allen | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8263 | Raymond Waltin | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8264 | Shelene Hamilton | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8265 | Winston M Orr \Denise Orr | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8272 | Casilda Rowe | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8273 | Trudeian Francis | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 8274 | Howard Benloss | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 8278 | Monica Hall | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8279 | Orville Thomas | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8280 | Claudette Channer | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8288 | Wayne Powell | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8289 | Dalbert Powell | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8293 | Tarick E Latchman | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8327 | Rickie Clarke | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 8412 | Maxine Isaacs #2 | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8422 | Charlene Rhoden | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8444 | Marsha Lofters | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 8445 | Stacey-Ann Cunningham | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8447 | Collette Campbell | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 8448 | Linford Boothe | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 8450 | Shelli-Gaye Bignall | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 8453 | Texroy Elliott | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8455 | Sarita White/Tommy Wilburn | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8460 | Tessa Morgan | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 8464 | Kenneil Smith | 2026-09-12 | 2026-09-22 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 8469 | Randy Barrett | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8473 | Clover Mattocks | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 8474 | Cheryl Hendricks | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8475 | Patarica Miller | 2026-09-13 | 2026-09-23 | covered_by_receipts | -1,250.00 | 0.00 | -1,250.00 |
| 8477 | Shavar Manning | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8483 | Carlene Brown-Victoria Town | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8485 | Donavan Thompson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8489 | Sharmane Taylor | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8491 | Jesmala Brown | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8492 | Cecil Wilson | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8493 | Lashawn Young | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8496 | Tania Bryan | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8573 | Roshene James | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8575 | Errol Rochester | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8582 | Suezette Barnes | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8584 | Beverly Stultz | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8586 | Sherika Simmonds | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 8589 | Mr Kadian Delroy Mighty | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8590 | Pamecia Powell | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8592 | Michael Forbes | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8594 | Paul Powell | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 7,500.00 | 7,500.00 |
| 8597 | Frank Dowdie | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 8599 | Mahalla Mills | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8602 | Albertha Morgan | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8604 | Denise Newell | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8610 | Daimion Salmon Mini Mart | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8613 | Joseph Miller | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8614 | Winsome Thompson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8617 | Jaylen Webley | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8619 | Huwayne Thompson | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8623 | Andia Harris | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8625 | Camala Coley | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8627 | Jewell Miller | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8628 | Dennis Anderson | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8629 | Kenrick Rowe | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8631 | Kadreana Morris | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8633 | James Dawkins | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8635 | Vincent Edwards | 2026-09-15 | 2026-09-25 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 8638 | Deron Bent | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8763 | Shanique Brooks-Smith | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8787 | Ann marie Bailey Oconnor | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8789 | Romonia Y Tulloch | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8790 | Heather Salmon | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8800 | Pancheta Davy | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8807 | Tamika McCallum | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8810 | Rose Lilliard | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8813 | Alverna Mckenzie | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8828 | Angela Edgar | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8830 | Tamara Mcclear #2 | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 8836 | Florezel Byrd | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 8837 | Keneshia Robinson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 8845 | Patrice Forbes | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8848 | Rasheed Hutchinson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 8849 | Barrington Harris | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 8850 | Treacia Roach | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8853 | Kern Morris | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 8859 | Donald Samuels | 2026-09-15 | 2026-09-25 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 8860 | Roshane Harrison | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 9006 | Marcia Campbell-Dillon | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9008 | Daisy Francis | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 9014 | Tiandra Rowe | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 9019 | Nickesha Fuller | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9023 | Nakita Henry | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9025 | Kirk White | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9027 | Griffith Compumax | 2026-09-10 | 2026-09-20 | covered_by_receipts | -1,500.00 | 0.00 | -1,500.00 |
| 9028 | Twyanne Swaby Wallace | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9030 | Berve Levy | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 9034 | Shaldon Daley | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9035 | Shaneka Hutton | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9036 | Andria Brown | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 1,100.00 | 1,100.00 |
| 9043 | Miralie Wright-Powell | 2026-09-14 | 2026-09-24 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 9046 | Lorna Barton | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 9048 | Michelle Hogg | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9049 | Sharna Roach | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9139 | Charles Benbow 2 (Cedar Grove) | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9141 | Ochane Ennis | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 9149 | Mitzie Clarke | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 9160 | Michelle Townsend | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9161 | Vivinnie Nelson | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9167 | Monica Burton | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9173 | Nattlee King | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9174 | Melisande Johnson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 9179 | Deon Duncan | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 9181 | Madge Hewitt | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9182 | Alecia Edwards | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9184 | Carlton Nembhard | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9185 | Jerome Mccatty | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9189 | Kesha Miller | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9190 | Lavern Brown | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9258 | Tesrick Butler | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 9277 | Jeremiah Hines | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 9311 | Vanneca Ellis | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 9313 | Paul Baker | 2026-09-13 | 2026-09-23 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 9314 | Maxwell Turner | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9323 | Nichole Robinson-Arkins | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 9516 | Marvia Wallace | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9524 | Mary Nicholson | 2026-09-05 | 2026-09-15 | review_unlabelled_receipts | -500.00 | 0.00 | -500.00 |
| 9526 | Clive Hoosang | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 9527 | Samuel Taylor | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 9530 | Yvonne Clarke | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9535 | Latoya Wood | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 9601 | Winnifred Paisley | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9611 | Heginton Bennett | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9640 | Sebert Williams | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9644 | Emelia Pryce | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9687 | Andrianna Rhoomes | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9698 | Brenda Ferrari 2 | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 1,800.00 | 1,800.00 |
| 9754 | Kayon Rowe | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9776 | Carlton Windett #2 | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9827 | Munair Bennett | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 8,500.00 | 8,500.00 |
| 9832 | Stacy Ann Hanson | 2026-09-13 | 2026-09-23 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 9845 | Fabian Marshall | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 9846 | Clyan Edwards | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9849 | Shepstone Reid-Hamilton | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 9863 | Simon Chambers | 2026-09-07 | 2026-09-17 | covered_by_receipts | -500.00 | 0.00 | -500.00 |
| 9865 | Annmarie Knight | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 9942 | Lillian Thompson | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9945 | Telsia Reid | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 9946 | Karlene Heron | 2026-09-06 | 2026-09-16 | review_later_charges | -500.00 | 0.00 | -500.00 |
| 9949 | Gladstone Lynch | 2026-09-06 | 2026-09-16 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 9953 | Alcyon Mullings | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9966 | Calvert C Campbell | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9976 | Sanatana Gordon | 2026-09-10 | 2026-09-20 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 9978 | Carol Moore | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9979 | Atalya Wallace (Shop) | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9982 | Louise Knight | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 9990 | Karen Leachman-Daley | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 9994 | Avril Cameron | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9996 | Anna-kaye Powell | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 9998 | David Miller | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10000 | Magetta Minott | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10002 | Ralston Taylor | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 10004 | Natali Williams #2 | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10006 | Jerome Miller | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 1,750.00 | 1,750.00 |
| 10008 | Sonia Mitchell-Berry Hill | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 10009 | Deon bligen | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10010 | Antonette Chance | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 10011 | Belusha Minnel | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10014 | Wesley Graham | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10015 | Kellicheran Butler | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10020 | Otis J Smith | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10027 | Oliver Roy McFarlane | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10030 | Devaughny Slowley | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 10138 | Sorman Blair | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10167 | Althea Verenia White #2 | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10174 | Ovan Thompson | 2026-09-06 | 2026-09-16 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 10177 | Williston Gayle | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 10178 | Dwight Williams-Grove Town | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10182 | Tajera Stephenson | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10192 | Sasha-Gay Carnegie | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10195 | Nicola Stewart | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 8,500.00 | 8,500.00 |
| 10196 | Nasheva Campbell | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10197 | Zallutar Johnson | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10204 | Annakay Kennedy | 2026-09-09 | 2026-09-19 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 10207 | Kimone Robinson | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10214 | Hillen Raymond | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 10216 | Margaret Rumble | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 10220 | Karen Murray Dawes | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10222 | Marlene Lyons | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10225 | Paul Larmond | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 10237 | Joseph Nelson | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10314 | Christine Graham #3 | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10344 | Norma Reid | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10347 | Dannys Gamings Lane #4 | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 10354 | Jody-Ann Smith | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10356 | Dave Burrell | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10358 | Donna Smith #2 | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10361 | Lois A Palmer | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 6,500.00 | 6,500.00 |
| 10370 | Oshene Reid | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10371 | Hubert Larmond | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 8,500.00 | 8,500.00 |
| 10372 | Marshalee Williams | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10383 | Serone Usherwood | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10385 | Coleen Palmer-Freckleton | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 10387 | Loraine Powell | 2026-09-14 | 2026-09-24 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 10389 | Dotcie Richards | 2026-09-15 | 2026-09-25 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 10390 | Stacy Ann Clemtson-Lambert | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10480 | Daneil Stone-Edinburgh | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10546 | Andrea Forrester-Rent Land | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10576 | Carl Mcdaniel | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10578 | Kishema Brown | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10579 | Yevette Pryce-Higgins | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10583 | Aickersha Douglas | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10586 | Loletta Morgan | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10591 | Kedaine Williams | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10603 | Kerry-Ann Reynolds/Alfredo Stephens | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 10612 | Shelly-Ann Palmer-Pryce | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10615 | Paddy Boucher | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10616 | Diana Samuels Edmund | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10723 | Leonard Wright-Newfield | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10728 | Tasheka Thyme | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10729 | Ann Marie Smikle | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10773 | Sheneva Martin | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 10784 | Josephine Gunn | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10787 | Alicia Smith | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10790 | Cassandra Gray | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10796 | Ashely Smith | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10810 | Kyla-lee Andrews | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10812 | Sharon Early Childhood | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 10813 | Clovet Lewis | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10814 | Roxbert Whynes | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10825 | Ian Lawe | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10826 | Felicia Jones | 2026-09-10 | 2026-09-20 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 10833 | Orlando Reid #2 | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 10834 | Monica Glave #2 | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10837 | Marva Hill | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10838 | Darnett Grizzle | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10840 | Marvin Hemmings | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10841 | Natasha Bryan | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10843 | Albert Allen | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10845 | Andrew Collins | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 10848 | Lorna Buchanan | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10849 | Jannette Malcolm | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 10851 | Lowell Hynes | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 10852 | Donald Wheatle | 2026-09-13 | 2026-09-23 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 10857 | Ashford Rowe | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10859 | Dwayne Mullings | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 10866 | Sherlock Reid | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10867 | Sashana Tyndale | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 10990 | Tricia Campbell | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11058 | Venessa Shaw | 2026-09-06 | 2026-09-16 | covered_by_receipts | -2,000.00 | 0.00 | -2,000.00 |
| 11066 | Andenet oneness Battersbee | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 11071 | Charmane Nembhard | 2026-09-06 | 2026-09-16 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 11073 | Shantel Craig | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11078 | Annette Parkinson-Morgan | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11080 | Nickay Holness | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11081 | Cherine Foster-Ballynure | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11082 | Sheena Splatt | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11084 | Marvin Dean | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11087 | Lakisha Langley | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11091 | Karl robinson | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11094 | Hermine Smith | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11095 | Lavern Campbell Frenandez | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 11114 | Renisha Samuels -Martin Castle | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11115 | Andrene Stewart Lamey | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11119 | Shanida Sutania Spence | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11121 | Jennifer Green / Keron Green | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11123 | Lena Malcom/ Kerrian Goulbourne | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11130 | Delroy Junior Gunn | 2026-09-12 | 2026-09-22 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 11131 | Romona Thompson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11133 | Dawnette Davidson | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11139 | Sheldon Jones | 2026-09-13 | 2026-09-23 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 11140 | Joyce Samuels | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 11142 | Jermaine Wright | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11147 | Sylvia Boucher | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11153 | Mervoline Nembhard | 2026-09-14 | 2026-09-24 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 11154 | Carmen Richards | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11155 | Sharlene Freckleton/Audrey Brooks | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11161 | Woneek Shirley #2 | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11165 | Shakea Johnson | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11166 | Evon Grant | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11331 | Paul Walker | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11340 | Jermaine Howe | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11341 | Martinez Morrison | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11342 | Vinnette Cooper | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11369 | Patrice Biggs | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11371 | Carol Peters | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11376 | Omar Mcnally | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11377 | Jermaine Gayle | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11381 | Desrine Williams | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11382 | Tracey-Ann Lawrence | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11384 | Caroline Johnson | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11387 | Karen brown | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11390 | Fay Bailey 2 | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11391 | Carlton Smith-cedar grove | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11394 | Tamara Chin | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11395 | Maureen Whyte | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11398 | Moesha Morrison | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11524 | Carol Meade | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11540 | Ruth-ann Campbell | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11543 | Raybian Trowers | 2026-09-10 | 2026-09-20 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 11550 | Tyrone Grant | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11551 | Keith Allen | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11552 | Yoki Moue Reid #2 | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11556 | Karen Davis | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11557 | Jason Gordon | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11558 | Abigail Watson (Swabys Hope) | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11562 | Sheniel McDonald | 2026-09-11 | 2026-09-21 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 11563 | Latonia Ward | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11564 | Chad Levy | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11566 | Neville plummer | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11568 | Cornelius Derby | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11569 | Shaneka Tyrell | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11576 | Deleta Lawrence | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11577 | Shermaine Lawrence | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11581 | Renardo Butler | 2026-09-14 | 2026-09-24 | covered_by_receipts | -500.00 | 0.00 | -500.00 |
| 11582 | Cecil Larmond | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 11583 | Layten walker | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11587 | Jermaine Taylor | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11588 | Nickoye Burrell/Shelly Ann Burrell | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11589 | Janet Wilmoth | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11591 | Ingrid Biggs | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11592 | Clinton Archibald | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11596 | Patrice Hynes | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11599 | Lemar Smith | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11601 | Sanchea Alcock | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11603 | Lynval Gordon | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11723 | Kemell Brown #1 | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11734 | Kemell Brown #2 | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11736 | Jahvaugh Weller | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11769 | Bryan Thomas #2 | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11773 | Chevanese Blackwood #2 | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11817 | Dale Collins #1 | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11830 | William Stephen Flash #2 | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11831 | Nordia Cunningham | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11834 | Davon Briscoe | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11841 | Omega Obrien | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11858 | Lavern Francis | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 5,500.00 | 5,500.00 |
| 11860 | Marigold Care Home | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11866 | Sharon Knight | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 11891 | Sabrina Clarke | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 11893 | Anthony Ray Edmund | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 11911 | Alecia Mitchell | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 11926 | Alcisha Bailey | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12040 | Rosealee Robinson | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12043 | Nigel Howell | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12050 | Tonia-Ann Mattis | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12064 | Georgiana Johnson | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12068 | Pauline Douglas-Crofts Hill | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12069 | Audreylyn Campbell | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12071 | Ini Rodlein | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12072 | Shanila Johnson | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12090 | Channette Young | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12093 | Elecia Mckenzie Williamson | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12094 | Chicken Hut/Lenford Hayles | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12097 | Peta Gaye Meeks | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12099 | Ann Marie Smith | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 12107 | Tajshae Wilson | 2026-09-10 | 2026-09-20 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 12108 | Angelicka Howitt | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 12112 | Dwight Turner #2 | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12122 | Kashina Grant | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 250.00 | 250.00 |
| 12123 | Camille Brooks McKenzie | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12124 | Keala Barrett | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12130 | Ramon Wilson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12144 | Junie Benloss | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12146 | Windsor Farm New Testament Church of God/Kimani Heath | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12150 | Shana-gay Harrison | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12153 | Jatee Morgan | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12154 | Monica Hutchinson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12155 | Leaford Scarlett | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 12156 | Antwone Haye | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 12157 | Judith Beckford#2 | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12160 | Roxann Mills | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12166 | Shantel Afflick | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12167 | Iris Smith | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12168 | Wilbert Jackson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12173 | Nevart Walker | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 12176 | Deon Charmaine Lindsay | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12249 | Paul Francis | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 12308 | Asonya Malcolm | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12332 | Cleveland Virtue | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 12338 | Noel Palmer | 2026-09-10 | 2026-09-20 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 12339 | Rosemarie Hart Muir | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12344 | Shakira Morgan | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12346 | Neville Brown-Lucea | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 12347 | Lishaun Eurice Miller | 2026-09-06 | 2026-09-16 | covered_by_receipts | -3,000.00 | 0.00 | -3,000.00 |
| 12348 | Shianna Mclaren | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 12349 | Evelyn Forbes Nelson | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12353 | Damone Irwin | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12355 | Jasceia Walker | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12359 | Sandre Carridice | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 12364 | Marcia Samuels | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 12371 | Pat Morgan | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12373 | Kimesha Fraser | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12374 | Grove Town Primary and infant | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12376 | Shellece Green | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12377 | Mary Ann Eubanks#2 | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12383 | Grace-Ann Griffiths/Manchester Real Foods Ltd | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12385 | Marcus Rattery-pear tree | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12387 | Sonia Nelson | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12388 | Sheryl Gallmore Palmer | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12389 | Marcia Brown-Reckford | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12391 | Calvin Smith | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12393 | Marc Millyan Enterprise Solutions #2 | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12394 | Karen Hibbert | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12396 | Surena Blake #2 | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12423 | Gairy Lyons | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12506 | Florence Grant | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12515 | Olive Ebanks | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12518 | Justin Dixon | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12520 | Jennifer Baker | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12532 | Shermalee Logan | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 12533 | Richard Mullings | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12535 | Nicholas Douglas | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12550 | Nadeisha Jones | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12551 | Randy Reid | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12552 | Gary Smith-Daleys Grove | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12558 | Kerry-Ann Blackwood Smith | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 12560 | Shakiel Lewis | 2026-09-14 | 2026-09-24 | covered_by_receipts | -500.00 | 0.00 | -500.00 |
| 12627 | Moureen Walters | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12632 | Kimberley Ferguson | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12636 | Kimone Adlam | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12638 | Lena Gonzalez | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12640 | Shanae Smith | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12663 | Felecia Morris | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12664 | Rackesha Measha Young #2 | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12668 | Caroline Johnson #2 | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12673 | Flavia Simpson | 2026-09-07 | 2026-09-17 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 12696 | Jermaine Wright #2 | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12698 | Kevar Bennett | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12700 | Mervalee Lewars-Baliey | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12701 | Beverly Bennett | 2026-09-09 | 2026-09-19 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 12704 | Alecia D Bell | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12705 | Gregory Gordon | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12706 | Florence South | 2026-09-11 | 2026-09-21 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 12711 | Mitzie Johnson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12713 | Joy Green | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12714 | Jermaine Delisser | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12716 | Nordia Murray-Mitchell | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 12723 | Taneisha McCaty | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12724 | Maureen Spencer | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12726 | Janelle Bailey | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12730 | Lacy-Ann Roye | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 12731 | Traceroy Dixon | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12732 | Mickashaye Mighty | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12735 | Christina Graham/Evetta Allen | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12736 | Elsa Mcpherson | 2026-09-15 | 2026-09-25 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 12738 | Michael Ebanks | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12742 | Nescesta Riley | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12744 | Will Smith | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12745 | Cheryl Hogg | 2026-09-14 | 2026-09-24 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 12864 | Latoya Francis | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12868 | Tommeco Bennett /Michella Haye | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12874 | Mellisa Bailey Glave | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12875 | Jazanie Lewis | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12876 | Nekesia Lewis | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12880 | Shanakay Reid | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12883 | Kenneth Alladeen | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12885 | Kiva Griffiths | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12890 | Sanika Hylton | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12896 | Kemeshia Edwards | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12904 | Owen Robinson | 2026-09-10 | 2026-09-20 | covered_by_receipts | -1,450.00 | 0.00 | -1,450.00 |
| 12907 | Tanya N Gordon -Allen | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12908 | Shamiesha Nelson | 2026-09-11 | 2026-09-21 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 12912 | Mignon Thomas | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12913 | Carla Hollingsworth | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12914 | Adrain Freckleton | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12915 | Renese Bailey | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 12916 | Tregetta Bonnick-Reckford | 2026-09-15 | 2026-09-25 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 12917 | Yasheka Lewis | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12918 | Kimberlyn Morgan | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12920 | Akeem Henry | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12921 | Veronica Salmon | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12924 | Tanica Richards | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12925 | Carlington Barrett-Heathfield | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12928 | Alfredo Kirlew | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 12929 | Fiona Patterson | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 12931 | Tashmarie Wright | 2026-09-15 | 2026-09-25 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 12932 | Denisha Orr | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 8,500.00 | 8,500.00 |
| 13104 | Theresa Edwards #2 | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13177 | Cheraine Miller | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 13178 | Kedisha Johnson-Campbell | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13180 | Leisia Griffiths | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13184 | Sherrian Simpson Smith | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13187 | Lacia Green | 2026-09-05 | 2026-09-15 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 13189 | Opal Scott | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 13190 | Soleen Elliott | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13191 | Yvonne Hibbert-Meadsfield | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13195 | Shawn Levy | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13199 | Clifton Floyd Mckenson | 2026-09-09 | 2026-09-19 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 13211 | Shenel Nelson | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13212 | Samuel Hayles | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13215 | Francella Cole | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13216 | Joseph Bonnick | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13219 | Casian Morgan | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13220 | Barrington Douglas Bennett | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13223 | Sherpa Gordon | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13224 | Bryony Bonnick | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13225 | Cassandra Ellington | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13230 | Nicola Weller | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13231 | Sasha Hamilton | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13233 | Glasford Logan | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13241 | Assured Wholistie Development Service | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13243 | Maria Benjamin #1 | 2026-09-12 | 2026-09-22 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 13244 | Terrence Thomas | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13245 | Debbie Ann Ormsby | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13247 | Rosemarie Chantiloupe | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13248 | Crystal Levy | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13250 | Rohan Brown | 2026-09-12 | 2026-09-22 | proposed_restore | -3,000.00 | 3,000.00 | 0.00 |
| 13254 | Felisha Baker#2 | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13255 | Rodger Whittaker | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13257 | Garcia Powell | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13259 | Tamaim Richards Mckay | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13260 | Bernice Smith Lee | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13262 | Derrick Douglas | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13265 | Mitchka Thomas | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13288 | Mark Clarke | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13290 | Marlyn Forrester | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13291 | Simone Vernal | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 1,250.00 | 1,250.00 |
| 13293 | Shanique Cross | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13296 | Shannika Francis | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13297 | Sheba Watson | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 13509 | Sashorna Barnes | 2026-09-15 | 2026-09-25 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 13566 | Andrea Williams-Green Street | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 200.00 | 200.00 |
| 13568 | Thea Daley#1 | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13660 | Rajwayne Spence | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13662 | Shaneka Gray | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13665 | Neville Bennett | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13687 | Carol Palmer | 2026-09-09 | 2026-09-19 | covered_by_receipts | -1,000.00 | 0.00 | -1,000.00 |
| 13688 | Daniel Williams | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13689 | Nikita Johnson | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13690 | Marcia Francis-Pratville | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13691 | Natasha Francis | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13698 | Patrice Noble | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 13699 | Tashanna Thomas | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13701 | Noel Dixon | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13702 | Nadine Smith Gordon | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13704 | Valaria May Blake | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13706 | Thea Daley#2 | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13707 | Shackera Thomas | 2026-09-12 | 2026-09-22 | proposed_restore | -2,000.00 | 2,000.00 | 0.00 |
| 13709 | Eileen Blagrove | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13710 | Faithlyn Granville | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 13712 | Romario Smith | 2026-09-13 | 2026-09-23 | proposed_restore | -3,000.00 | 2,800.00 | -200.00 |
| 13713 | Nicola Flemmings | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13714 | Robert Powell #2 | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13715 | Andrea Smith | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13717 | Reana Douglas | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13718 | Collette Thompson-Black | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 13720 | Andre Wright | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13721 | Andy White | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13722 | Rhoan Scott | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 13724 | Marcia Murphy | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13725 | Jeneta King | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13727 | Christine Marie Williams | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13730 | Kediash Anekia Plummer | 2026-09-15 | 2026-09-25 | proposed_restore | -4,000.00 | 4,000.00 | 0.00 |
| 13732 | Doreen Simpson/Joseph Simpson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13733 | Sharon Allen | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13734 | Claude Mckay | 2026-09-15 | 2026-09-25 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 13739 | Heather Solas | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13740 | Melesia Lawson | 2026-09-15 | 2026-09-25 | proposed_restore | -3,000.00 | 3,000.00 | 0.00 |
| 13920 | Kemonie Simister | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 13921 | Lenqiue Stephens | 2026-09-06 | 2026-09-16 | covered_by_receipts | -5,000.00 | 0.00 | -5,000.00 |
| 13927 | Elizabeth Allen | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 180.00 | 180.00 |
| 13928 | Andre Davis | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13934 | Cameila Simpson | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13936 | Trudy Ann Blake | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13939 | Valerie Johnson | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13945 | Jody Ann West- salmon town | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13947 | Carey Robinson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 13948 | Andy Johnson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13950 | Tashika Marshall | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 13951 | Ebonie Nelson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 13952 | Nickesha Ellington | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13953 | Gordana Donaldson | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 13954 | Shameika Young | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 13955 | Tamika Turner | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 13956 | Barbara Oxford#2 | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 13958 | Sasckia Flemming | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14009 | Jeptha Lewis | 2026-09-06 | 2026-09-16 | covered_by_receipts | -3,000.00 | 0.00 | -3,000.00 |
| 14070 | Deandra Chance | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14080 | Justin Morris | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14089 | Shaeyana Tomlin | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14093 | Dashane Blake | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14095 | Rabbie McLean | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14096 | Radcliffe Fearon | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 14098 | Lesley Ann Guy | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14103 | Theresa Barnes-Allen | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 7,500.00 | 7,500.00 |
| 14119 | Mercilda Rose | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14120 | Eleoria M Rankine | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 14124 | Brenton Parker | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14125 | Shameca Williams | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14126 | Kerry-ann Powell #3 | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14129 | Latasha Rose | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14131 | Jossan Rowe | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 14132 | Zaleka Richards | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14133 | Faithlyn Stone-Taylor | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14134 | Peter Gay Facey | 2026-09-12 | 2026-09-22 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14136 | Jevaun Howell | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14137 | Angela Marinana Russell | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14142 | Tywanna Sterling | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14143 | Jody-Ann Jones Brown | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 14145 | Joan Watson | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 5,000.00 | 5,000.00 |
| 14154 | Staceyann Blackwood | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14156 | Tracy-Ann Gonzalies | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14157 | Danvil Dunn | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14158 | June Dixon | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 7,500.00 | 7,500.00 |
| 14159 | Debbie Griffiths-Fuller | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14160 | Shantel Morgan | 2026-09-15 | 2026-09-25 | proposed_restore | -3,000.00 | 3,000.00 | 0.00 |
| 14164 | Karese Chaplin | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14168 | Ackeem Caine | 2026-09-15 | 2026-09-25 | proposed_restore | -5,000.00 | 5,000.00 | 0.00 |
| 14173 | Hyacinth Chambers | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14186 | Naomi Samuels | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14367 | Joyce Mckenzie Rowe#2 | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14369 | Inez Collins | 2026-09-05 | 2026-09-15 | covered_by_receipts | -3,000.00 | 0.00 | -3,000.00 |
| 14372 | Kimoya Smith | 2026-09-05 | 2026-09-15 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14378 | Ellen Robinson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14382 | Keith Powell | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14384 | Milton Powell | 2026-09-06 | 2026-09-16 | proposed_restore | -3,000.00 | 2,000.00 | -1,000.00 |
| 14387 | Marian Roach | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 14399 | Donovan Johnson #2 | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14401 | Suzette Hamilton | 2026-09-07 | 2026-09-17 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14406 | Keisha Miller | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 4,500.00 | 4,500.00 |
| 14407 | Michelle Scott Robertson | 2026-09-08 | 2026-09-18 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14410 | Juliet Morgan #2 | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14417 | Ann Marie Tucker | 2026-09-09 | 2026-09-19 | proposed_restore | -3,000.00 | 3,000.00 | 0.00 |
| 14419 | Pam Brown | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14423 | Nigel Dawkins | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14427 | Monica Nelson | 2026-09-09 | 2026-09-19 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14428 | Carl Powell | 2026-09-09 | 2026-09-19 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 14431 | Carol Smith | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 1,500.00 | 1,500.00 |
| 14433 | Fabian Forbes | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14437 | Kacian Edwards | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14438 | Winston Knight | 2026-09-12 | 2026-09-22 | proposed_restore | -4,500.00 | 4,500.00 | 0.00 |
| 14440 | Jardon White | 2026-09-10 | 2026-09-20 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 14445 | Alton Francis | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 14446 | Shantel Clarke/Ajornie Henninham | 2026-09-13 | 2026-09-23 | proposed_restore | -3,000.00 | 3,000.00 | 0.00 |
| 14447 | Jeffery Beckford | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14449 | Novan Pinnock | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14450 | Islande Picard Stephenson | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14451 | Annmarie Pinnock | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14452 | Rosemary Davis | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14454 | Delcia Thompson | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14455 | Renisha Samuels-SeaView Rx | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14457 | Princess Thomas | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14458 | Deanny Ross | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14460 | Everton Ferquson | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14462 | Keian Turner | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 14464 | Stacyann Reid | 2026-09-14 | 2026-09-24 | proposed_restore | -3,000.00 | 3,000.00 | 0.00 |
| 14465 | Kimberely Campbell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14466 | Nneka-Shay Wilson #2 | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14467 | Javon Crawford | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14475 | Racquel Levy-Chambers | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14478 | Shelton K Stephens | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14482 | Anthony Litchmore | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14483 | Earman Jackson | 2026-09-15 | 2026-09-25 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14486 | Shana-Kay Plummer | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14488 | Taneisha Hinds | 2026-09-15 | 2026-09-25 | proposed_restore | -3,000.00 | 3,000.00 | 0.00 |
| 14489 | Petrina Fairman | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 2,000.00 | 2,000.00 |
| 14492 | Fiona Hall #2 | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 3,000.00 | 3,000.00 |
| 14494 | Sonia Brown | 2026-09-15 | 2026-09-25 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14543 | Sharona Haughton | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14568 | Allison Porter | 2026-09-11 | 2026-09-21 | covered_by_receipts | -2,500.00 | 0.00 | -2,500.00 |
| 14594 | Sharal Bent | 2026-09-11 | 2026-09-21 | proposed_restore | -2,500.00 | 2,500.00 | 0.00 |
| 14628 | Shani Robinson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14634 | Renae Reid-Mandeville | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 4,000.00 | 4,000.00 |
| 14651 | Warren Powell | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 1,000.00 | 1,000.00 |
| 14663 | Marcus Rattery | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14682 | Vanessa Palmer-Wright | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14721 | Othaniel Ricketts | 2026-09-13 | 2026-09-23 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 14733 | Audrey Francis | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14744 | Patsy Ellington | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 14753 | Othniel Mclean | 2026-09-14 | 2026-09-24 | covered_by_receipts | -1,500.00 | 0.00 | -1,500.00 |
| 14774 | Beverley palmer | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 14796 | Conroy Wright | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14797 | Nicole Pennant | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14815 | Charmaine Simpson | 2026-09-07 | 2026-09-17 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14847 | Lorriane Linton Spence | 2026-09-05 | 2026-09-15 | covered_by_receipts | -2,000.00 | 0.00 | -2,000.00 |
| 14899 | Tomica Escoffery | 2026-09-06 | 2026-09-16 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14928 | Nadine Wheatley | 2026-09-14 | 2026-09-24 | proposed_restore | 0.00 | 3,500.00 | 3,500.00 |
| 14939 | Shavane Brown #2 | 2026-09-09 | 2026-09-19 | proposed_restore | 0.00 | 500.00 | 500.00 |
| 14948 | Ke Deniah Ledgister | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14967 | Barrington Lewis | 2026-09-10 | 2026-09-20 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14975 | Cecil Huss | 2026-09-15 | 2026-09-25 | review_unlabelled_receipts | 0.00 | 0.00 | 0.00 |
| 14976 | Aisha Wood #1 | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14978 | Aisha Wood #2 | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14980 | Dale Robinson | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14982 | Winsome Crawford Sunset | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14984 | Paul Halstead | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 14990 | Alford Davy | 2026-09-11 | 2026-09-21 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 15006 | Daniel Miller | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 15009 | Jermaine Richards | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 15010 | Nelesha Williams | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 15011 | All American Institute of Medical sciences/Jennifer Gutherie #3 | 2026-09-06 | 2026-09-16 | proposed_restore | 0.00 | 13,000.00 | 13,000.00 |
| 15019 | Jodi Ann Dyce | 2026-09-12 | 2026-09-22 | review_due_allocation | 0.00 | 0.00 | 0.00 |
| 15021 | Shirley Johnson | 2026-09-12 | 2026-09-22 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 15031 | Roxroy Finn | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 15032 | Eudalin Brown | 2026-09-13 | 2026-09-23 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 15039 | Shaneika Higgins | 2026-09-05 | 2026-09-15 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 15049 | Marcia Livingstone | 2026-09-14 | 2026-09-24 | covered_by_receipts | 0.00 | 0.00 | 0.00 |
| 15059 | Shandel Dawson | 2026-09-11 | 2026-09-21 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
| 15071 | Antoinette Jones | 2026-09-13 | 2026-09-23 | covered_by_receipts | -2,000.00 | 0.00 | -2,000.00 |
| 15078 | Clive vascell | 2026-09-08 | 2026-09-18 | proposed_restore | 0.00 | 2,500.00 | 2,500.00 |
