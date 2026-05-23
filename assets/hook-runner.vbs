' Caliber hook runner — invokes a child command hidden + waits for exit.
'
' The Windows flash this avoids: Claude Code spawns hook commands via
' child_process.spawn without windowsHide:true. When the hook command
' is a console-subsystem binary (node.exe, python.exe, cmd.exe …),
' Windows allocates a new console window for it that flashes onto the
' user's desktop for the lifetime of the call. Anthropic closed
' anthropics/claude-code#19012 as "not planned"; this VBS is the
' supported workaround they recommend.
'
' wscript.exe is windows-subsystem (no console allocated), so the
' OUTER spawn is silent. WScript.Shell.Run with intWindowStyle=0
' and bWaitOnReturn=True hides the INNER node child's window AND
' waits for it to exit so the parent (Claude Code) sees the real
' exit code. Stdout is NOT forwarded — this wrapper is only suitable
' for fire-and-forget hooks (learn observe, learn finalize, etc.)
' that don't return systemMessage / decision JSON to Claude Code.
'
' Usage:
'   wscript //nologo hook-runner.vbs <node.exe> <bin.js> [args ...]
'
' All arguments are quoted before being joined into a single command
' line for WScript.Shell.Run, so paths with spaces (e.g. "C:\Program
' Files\nodejs\node.exe") survive unchanged.

If WScript.Arguments.Count < 1 Then
  WScript.Quit(1)
End If

Dim cmd, i
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  If i > 0 Then cmd = cmd & " "
  cmd = cmd & """" & WScript.Arguments(i) & """"
Next

Set sh = CreateObject("WScript.Shell")
WScript.Quit(sh.Run(cmd, 0, True))
