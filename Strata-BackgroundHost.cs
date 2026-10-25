using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

// Compiled locally as a Windows GUI executable: Task Scheduler never launches
// a console application as its root process (Windows Terminal ignores SW_HIDE).
internal static class StrataBackgroundHost
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [STAThread]
    private static int Main(string[] args)
    {
        string state = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, @"..\.."));
        IntPtr job = IntPtr.Zero;
        try {
            Directory.CreateDirectory(state);
            if (args.Length != 1 || !Path.IsPathRooted(args[0]) || !File.Exists(args[0]))
                throw new ArgumentException("Expected one absolute PowerShell script path.");
            string script = Path.GetFullPath(args[0]);
            string name = Path.GetFileNameWithoutExtension(script);
            job = CreateJobObject(IntPtr.Zero, null);
            ExtendedLimits limits = new ExtendedLimits();
            // Stop the supervisor with this host; detached services it starts
            // keep their independent official lifecycle when startup is disabled.
            limits.Basic.Flags = 0x2000 | 0x1000; // KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK
            if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            ProcessStartInfo info = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"",
                WorkingDirectory = Path.GetDirectoryName(script),
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true
            };
            using (StreamWriter output = new StreamWriter(Path.Combine(state, name + ".host.stdout.log"), true))
            using (StreamWriter error = new StreamWriter(Path.Combine(state, name + ".host.stderr.log"), true))
            using (Process child = new Process { StartInfo = info }) {
                output.AutoFlush = true; error.AutoFlush = true;
                child.OutputDataReceived += (sender, e) => { if (e.Data != null) output.WriteLine(e.Data); };
                child.ErrorDataReceived += (sender, e) => { if (e.Data != null) error.WriteLine(e.Data); };
                child.Start();
                if (!AssignProcessToJobObject(job, child.Handle)) {
                    int code = Marshal.GetLastWin32Error();
                    child.Kill();
                    throw new System.ComponentModel.Win32Exception(code);
                }
                child.StandardInput.Close();
                child.BeginOutputReadLine(); child.BeginErrorReadLine();
                child.WaitForExit();
                return child.ExitCode;
            }
        } catch (Exception e) {
            try { File.AppendAllText(Path.Combine(state, "background-host.errors.log"), DateTime.UtcNow.ToString("u") + " " + e + Environment.NewLine); } catch { }
            return 1;
        } finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
