' Runs the duty watchdog with **no visible console window**, and relays the child's
' exit code back to the Windows scheduled task.
'
' Why this file exists
' --------------------
' A scheduled task that runs a console program directly (`node.exe watchdog.mjs`)
' makes Windows allocate a console for it. On this machine Windows Terminal is the
' registered default console host, so every run *launches a Terminal window* that
' appears for the fraction of a second the watchdog needs and then vanishes. Five
' times an hour, that is the "a terminal pops up and immediately closes" symptom.
'
' Why a VBScript and not the obvious alternatives
' ------------------------------------------------
'   * `powershell.exe -WindowStyle Hidden ...` still showed a Terminal window: the
'     flag hides the *child's* window, but PowerShell itself is a console program,
'     so Windows still hands it a console (and therefore still starts Terminal).
'   * `conhost.exe --headless ...` does hide the window, but it **swallows the exit
'     code** -- the task then reports "success" even when the watchdog crashed.
'   * `wscript.exe` is a *GUI* application: it never allocates a console, so it
'     never causes a console host to start. `WScript.Shell.Run` with window style 0
'     starts the child hidden, and `bWait = True` lets us hand the child's exit
'     code back to the scheduler.
'
' Arguments (passed by the scheduled task):
'   1. absolute path to node.exe
'   2. absolute path to watchdog.mjs
'   3. data directory (every remaining argument is joined to the command line)
'
' Exit code: the child's exit code, or 99 if the child could not be started.
Option Explicit

Dim shell, fso, i, nodeExe, watchdogPath, tail, command, exitCode, errNumber, errDesc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 2 Then
  WScript.Quit 98
End If

nodeExe = WScript.Arguments(0)
watchdogPath = WScript.Arguments(1)

' Everything after the script path is forwarded to the watchdog verbatim.
tail = ""
For i = 2 To WScript.Arguments.Count - 1
  If tail = "" Then
    tail = WScript.Arguments(i)
  Else
    tail = tail & " " & WScript.Arguments(i)
  End If
Next

command = """" & nodeExe & """ """ & watchdogPath & """"
If tail <> "" Then
  command = command & " " & tail
End If

' The two inputs have to exist before anything is started. A missing node.exe or a
' missing watchdog would otherwise start "successfully" and do nothing — and a
' watchdog that silently does nothing is the one failure mode this whole system
' exists to prevent.
If Not fso.FileExists(nodeExe) Then
  WScript.Quit 97
End If
If Not fso.FileExists(watchdogPath) Then
  WScript.Quit 96
End If

' 0 = hidden window, True = wait for the child so its exit code can be relayed.
On Error Resume Next
exitCode = shell.Run(command, 0, True)
errNumber = Err.Number
errDesc = Err.Description
On Error GoTo 0

If errNumber <> 0 Then
  WScript.Quit 99
End If

WScript.Quit exitCode
