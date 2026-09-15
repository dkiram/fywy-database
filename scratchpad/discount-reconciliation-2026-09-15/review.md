# Proposed initial billing correction

54 accounts; J$151750.00 outstanding debt to clear.
6 disconnected accounts move to pending_reconnection.

March-August 2026 month labels each total at least the current fee, excluding voids. Initial batch excludes negative receipts, positive ledger adjustments, higher historical charges, and due days after 15. This is a conservative screen, not verification of historical rates.

Balances were checked against every supplied ledger entry. SQL rechecks live balances and discount eligibility. The script uses employee 2 and ends in ROLLBACK. No database changes have been executed.

| ID | Customer | Status | Debt to clear (J$) |
|---|---|---|---:|
| 19 | Rosemarie Bennett | active | 4000.00 |
| 90 | Tyrone Daley | active | 2500.00 |
| 408 | Marjarie Whyte Wilks | active | 2500.00 |
| 440 | Jerry Griffiths | disconnected | 4000.00 |
| 632 | Celia Coley | disconnected | 4000.00 |
| 666 | Tameka Stephens | disconnected | 1500.00 |
| 809 | Ransford Richards | active | 3500.00 |
| 933 | Shanae Sergant | active | 2500.00 |
| 1079 | Careen Brown | active | 2500.00 |
| 1234 | Sona Mitchell | active | 2500.00 |
| 1242 | Kenrick Maxwell | active | 2500.00 |
| 1396 | Nadine Rhoden | active | 2500.00 |
| 1680 | Latoya Hewitt | active | 2500.00 |
| 1905 | Kadene Wright | active | 2500.00 |
| 2130 | Althea Richards | active | 4000.00 |
| 2434 | Judith Maitland | active | 2500.00 |
| 2443 | Amy Dixon | active | 2500.00 |
| 2448 | Shanakay Kentish | active | 2500.00 |
| 2927 | Kerry Ann West | active | 2500.00 |
| 3593 | Tanesha A.Smith | active | 2500.00 |
| 3622 | Sharon Blake | active | 3500.00 |
| 3638 | Sandra Albert | active | 2500.00 |
| 4714 | Suzette Bryan | active | 2500.00 |
| 4754 | Lenford L.Watson | active | 2500.00 |
| 4950 | Oshane Darby#2 | active | 2500.00 |
| 5479 | Richardo Williamson | active | 2500.00 |
| 6111 | Kimmoyie Blackwood | active | 2500.00 |
| 6134 | Clifton Golding | active | 2500.00 |
| 6239 | Odane L Findley | active | 2500.00 |
| 6365 | Merrick Samuda | disconnected | 4000.00 |
| 6393 | Lenford Plummer | active | 2500.00 |
| 6395 | Ishmael Cassanova | disconnected | 4000.00 |
| 6441 | Movetta Garwood | active | 4500.00 |
| 6475 | Danielle Plummer | disconnected | 4000.00 |
| 6525 | Joseph Edmund | active | 2500.00 |
| 6747 | Marva Morgan | active | 2500.00 |
| 6881 | Roland Edmond | active | 2500.00 |
| 7128 | Tyrellea Simms | active | 3500.00 |
| 7525 | Jermaine Royal | active | 2500.00 |
| 8251 | Shaven Dryden | active | 2500.00 |
| 10178 | Dwight Williams-Grove Town | active | 2500.00 |
| 10723 | Leonard Wright-Newfield | active | 2500.00 |
| 11371 | Carol Peters | active | 2500.00 |
| 12043 | Nigel Howell | active | 4000.00 |
| 12112 | Dwight Turner #2 | active | 2250.00 |
| 12153 | Jatee Morgan | active | 2500.00 |
| 12166 | Shantel Afflick | active | 2500.00 |
| 12515 | Olive Ebanks | active | 2500.00 |
| 12616 | Donna Burrell-Cocoa Walk | active | 2500.00 |
| 12627 | Moureen Walters | active | 2500.00 |
| 12726 | Janelle Bailey | active | 3500.00 |
| 12880 | Shanakay Reid | active | 2500.00 |
| 12883 | Kenneth Alladeen | active | 2500.00 |
| 12890 | Sanika Hylton | active | 2500.00 |

## Six-month screen exceptions

| ID | Customer | Outstanding (J$) | Reason to review |
|---|---|---:|---|
| 249 | AUDREY MITCHELL | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 571 | Christopher Ellington | 1500.00 | Nonvoid negative monthly receipt; resolve allocation |
| 786 | Lettice Elaine Morgan | 5500.00 | Nonvoid negative monthly receipt; resolve allocation |
| 2015 | Samantha Alicia Brown/Philip Woodley | 4000.00 | Nonvoid negative monthly receipt; resolve allocation |
| 2153 | Ezra Reynolds | 5000.00 | Nonvoid negative monthly receipt; resolve allocation; Existing positive adjustment; resolve reason before clearing |
| 2552 | Odette Wright | 3000.00 | Existing positive adjustment; resolve reason before clearing |
| 2827 | Clifton Williams | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 2939 | Simone Chisholm | 1000.00 | Nonvoid negative monthly receipt; resolve allocation |
| 3140 | Samishia Ellington | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 3321 | Cassandra Powell-Reid | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 3635 | Ronique Williams | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 3664 | Mexcior Graham | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 3904 | Melissa Williams | 2500.00 | Nonvoid negative monthly receipt; resolve allocation; Existing positive adjustment; resolve reason before clearing |
| 5630 | Lindon Rattray | 4000.00 | Nonvoid negative monthly receipt; resolve allocation |
| 5632 | Damion Williamson | 1500.00 | Nonvoid negative monthly receipt; resolve allocation; Existing positive adjustment; resolve reason before clearing |
| 5797 | Gilbert White | 2500.00 | Nonvoid negative monthly receipt; resolve allocation |
| 6791 | Keliah Bailey | 4000.00 | Nonvoid negative monthly receipt; resolve allocation |
| 7529 | Rosheda Lindsay | 2500.00 | Nonvoid negative monthly receipt; resolve allocation; Existing positive adjustment; resolve reason before clearing |
| 8192 | Tajay Reid | 2500.00 | Nonvoid negative monthly receipt; resolve allocation |
| 9025 | Kirk White | 5000.00 | Nonvoid negative monthly receipt; resolve allocation |
| 10138 | Sorman Blair | 2500.00 | Ledger monthly charge exceeds current monthly fee; Nonvoid negative monthly receipt; resolve allocation; Existing positive adjustment; resolve reason before clearing |
| 10344 | Norma Reid | 4000.00 | Nonvoid negative monthly receipt; resolve allocation |
| 12168 | Wilbert Jackson | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 12875 | Jazanie Lewis | 2500.00 | Nonvoid negative monthly receipt; resolve allocation |
| 12876 | Nekesia Lewis | 2500.00 | Nonvoid negative monthly receipt; resolve allocation |
| 12913 | Carla Hollingsworth | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 13149 | Samantha Morgan | 4000.00 | Nonvoid negative monthly receipt; resolve allocation |
| 13154 | Masreen Meridith | 2500.00 | Existing positive adjustment; resolve reason before clearing |
| 13180 | Leisia Griffiths | 2500.00 | Nonvoid negative monthly receipt; resolve allocation |
| 13220 | Barrington Douglas Bennett | 2500.00 | Nonvoid negative monthly receipt; resolve allocation; Existing positive adjustment; resolve reason before clearing |
| 14663 | Marcus Rattery | 3000.00 | Existing positive adjustment; resolve reason before clearing |
