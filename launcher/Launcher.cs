using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("多AI聊天平台")]
[assembly: AssemblyDescription("多AI聊天平台 Windows 启动器")]
[assembly: AssemblyProduct("多AI聊天平台")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool noBrowser = Array.IndexOf(args, "--no-browser") >= 0;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "ai-roundtable", "start-web.ps1");
        if (!File.Exists(script)) return Fail("请完整解压软件，并将 EXE 与 ai-roundtable 文件夹放在一起。", noBrowser);
        try
        {
            var info = new ProcessStartInfo();
            info.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -NoPause" + (noBrowser ? " -NoBrowser" : "");
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (var process = Process.Start(info))
            {
                // Drain both redirected streams asynchronously to avoid pipe deadlocks.
                var output = new System.Text.StringBuilder();
                var errors = new System.Text.StringBuilder();
                process.OutputDataReceived += (sender, e) => { if (e.Data != null) output.AppendLine(e.Data); };
                process.ErrorDataReceived += (sender, e) => { if (e.Data != null) errors.AppendLine(e.Data); };
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                if (process.ExitCode != 0) return Fail(output.ToString() + errors.ToString(), noBrowser);
            }
            return 0;
        }
        catch (Exception error) { return Fail(error.Message, noBrowser); }
    }

    private static int Fail(string message, bool quiet)
    {
        if (!quiet) MessageBox.Show(message, "多AI聊天平台", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}
