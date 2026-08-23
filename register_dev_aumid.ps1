$csharpCode = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class ShellLink {}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
public interface IPropertyStore {
    uint GetCount();
    void GetAt(uint iProp, out PropertyKey pkey);
    void GetValue(ref PropertyKey key, out PropVariant pv);
    void SetValue(ref PropertyKey key, ref PropVariant pv);
    void Commit();
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct PropertyKey {
    public Guid fmtid;
    public uint pid;
    public PropertyKey(Guid guid, uint id) { fmtid = guid; pid = id; }
}

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
    public static PropVariant FromString(string val) {
        var pv = new PropVariant();
        pv.vt = 31; // VT_LPWSTR
        pv.pwszVal = Marshal.StringToCoTaskMemUni(val);
        return pv;
    }
}

public class ShortcutHelper {
    public static void CreateShortcut(string shortcutPath, string targetPath, string aumid) {
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(targetPath);
        var pStore = (IPropertyStore)link;
        var pkey = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5); // PKEY_AppUserModel_ID
        var pv = PropVariant.FromString(aumid);
        pStore.SetValue(ref pkey, ref pv);
        pStore.Commit();
        ((IPersistFile)link).Save(shortcutPath, true);
    }
}
"@

Add-Type -TypeDefinition $csharpCode

$programs = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $programs "InstaDesk.lnk"
$targetPath = "$PSScriptRoot\..\src-tauri\target\release\instadesk.exe"
if (-not (Test-Path $targetPath)) {
    $targetPath = "$PSScriptRoot\..\src-tauri\target\debug\instadesk.exe"
}
if (-not (Test-Path $targetPath)) {
    $targetPath = (Get-Process -Name "powershell" -ErrorAction SilentlyContinue | Select-Object -First 1).Path
}

[ShortcutHelper]::CreateShortcut($shortcutPath, $targetPath, "com.instadesk.desktop")
Write-Host "Created Start Menu Shortcut with AUMID com.instadesk.desktop at: $shortcutPath"
