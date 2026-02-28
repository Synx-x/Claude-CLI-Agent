# ClaudeClaw + Claude Code side-by-side startup
$repo = Split-Path -Parent $PSScriptRoot


$launchScript = "$repo\scripts\launch-claude.ps1"
$wtArgs = "new-tab --title `"ClaudeClaw Bot`" -d `"$repo`" powershell -NoExit -Command `"npm start`" ; split-pane -H --title `"Claude Code`" -d `"$repo`" powershell -NoExit -File `"$launchScript`""

Start-Process wt -ArgumentList $wtArgs
