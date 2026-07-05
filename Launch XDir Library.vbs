Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
appDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = appDir
pythonwPath = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\Python\Python313\pythonw.exe")
If Not FSO.FileExists(pythonwPath) Then
    pythonwPath = "pythonw.exe"
End If
WshShell.Run """" & pythonwPath & """ """ & appDir & "\app.py""", 0, False
