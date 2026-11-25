| io | game/_start_game | 10 | first | slid to next row (line 11) @11 | exact @10 | PASS exact |
| io | game/_start_game | 14 | nonfirst | exact @14 | exact @14 | PASS exact |
| log | game/_start_game | 32 | first | slid to next row (line 33) @33 | exact @32 | PASS exact |
| log | game/_start_game | 35 | nonfirst | exact @35 | exact @35 | PASS exact |
| async-io | game/compute | 42 | first | exact @42 | exact @42 | PASS exact |
| async-io | game/compute | 43 | nonfirst | exact @43 | exact @43 | PASS exact |
| async-io | game/pipeline | 48 | first | slid elsewhere (line 49) @49 | exact @48 | PASS exact |
| async-io | game/pipeline | 50 | nonfirst | exact @50 | exact @50 | PASS exact |
| async-io | game/run | 60 | first | slid elsewhere (line 62) @62 | exact @60 | PASS exact |
| async-io | game/run | 62 | nonfirst | exact @62 | exact @62 | PASS exact |
| async-io | game/_start_game | 96 | first | slid elsewhere (line 98) @98 | slid elsewhere (line 98) @98 | still slid |
| async-io | game/_start_game | 98 | nonfirst | exact @98 | exact @98 | PASS exact |
| async-on-main-promise | game/base | 54 | first | no stop | no stop | unchanged: no stop |
| async-on-main-promise | game/base | 55 | nonfirst | no stop | no stop | unchanged: no stop |
| async-on-main-promise | game/mid | 60 | first | no stop | no stop | unchanged: no stop |
| async-on-main-promise | game/mid | 61 | nonfirst | no stop | no stop | unchanged: no stop |
| async-on-main-promise | game/outer | 69 | first | no stop | no stop | unchanged: no stop |
| async-on-main-promise | game/outer | 70 | nonfirst | no stop | no stop | unchanged: no stop |
| async-on-main-promise | game/main | 77 | first | no stop | no stop | unchanged: no stop |
| async-on-main-promise | game/main | 86 | nonfirst | no stop | no stop | unchanged: no stop |
| async-io | game/_game_running | 89 | single-row | exact @89 | exact @89 | PASS exact |
| io | game/_start_game | 22 | nonfirst | exact @22 | exact @22 | PASS exact |
| async-io | game/run | 67 | nonfirst | exact @67 | exact @67 | PASS exact |
| async-io | game/pipeline | 49 | nonfirst | exact @49 | exact @49 | PASS exact |
| io | ~lib/tension-framework/assembly/io/print | 73 | first | slid to next row (line 74) @74 | exact @73 | PASS exact |
| io | ~lib/tension-framework/assembly/io/print | 74 | nonfirst | exact @74 | exact @74 | PASS exact |
| io | ~lib/tension-framework/assembly/io/argCount | 96 | first | exact @96 | exact @96 | PASS exact |
| io | ~lib/tension-framework/assembly/io/arg | 101 | first | slid to next row (line 102) @102 | exact @101 | PASS exact |
| io | ~lib/tension-framework/assembly/io/arg | 102 | nonfirst | exact @102 | exact @102 | PASS exact |
| io | ~lib/tension-framework/assembly/io/argCount | 96 | first | exact @96 | exact @96 | PASS exact |
