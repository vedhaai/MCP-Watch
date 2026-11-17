using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Vedhaai.MCPWatch
{
    /// <summary>What to pass on (possibly changed, or null to drop it) and what to answer the sender with.</summary>
    public sealed class Outcome
    {
        public Outcome(Dictionary<string, object> forward, Dictionary<string, object> reply)
        {
            Forward = forward;
            Reply = reply;
        }

        /// <summary>The message to pass on, possibly rewritten (a poisoned tool removed, a secret redacted); null if it was refused.</summary>
        public Dictionary<string, object> Forward { get; }

        /// <summary>A JSON-RPC answer to send straight back to whoever sent the message; null when there is none.</summary>
        public Dictionary<string, object> Reply { get; }

        /// <summary><see cref="Forward"/> as one line of JSON, or null.</summary>
        public string ForwardJson => Forward == null ? null : Json.Write(Forward);

        /// <summary><see cref="Reply"/> as one line of JSON, or null.</summary>
        public string ReplyJson => Reply == null ? null : Json.Write(Reply);

        internal static Outcome Pass(Dictionary<string, object> message) => new Outcome(message, null);
    }

    /// <summary>
    /// The MCPWatch engine, run as a Node sidecar (<c>mcpwatch engine</c>).
    ///
    /// Every rule, the AI reviewer and the dashboard reporting live in the Node package; this class
    /// starts it as a child process and asks it about each JSON-RPC message, one JSON object per line
    /// each way. .NET guards stay thin, and a server in C# gets exactly the verdicts a Node server
    /// would. This is the .NET twin of <c>mcpwatch/engine.py</c> and <c>Engine.java</c>.
    ///
    /// One engine per guarded server, shared by every connection to it. Thread-safe.
    ///
    /// Checks never throw: if the engine can't be reached, a request is refused with
    /// <see cref="Blocked"/> (the default), or passed on unchanged when <c>FailOpen</c> is set.
    /// </summary>
    public sealed class Engine : IDisposable
    {
        /// <summary>The JSON-RPC error code for a message the guard refused.</summary>
        public const int Blocked = -32001;

        internal const string NpmPackage = "@vedhaai/mcpwatch";

        private readonly string _name;
        private readonly McpWatchOptions _options;
        private readonly Dictionary<string, object> _engineOptions;
        private long _ids;

        // What is waiting on the engine that is running now. Each start gets a fresh map, so a crashed
        // engine's reader can only ever fail the calls that were made to *it*.
        private volatile ConcurrentDictionary<long, TaskCompletionSource<Dictionary<string, object>>> _pending =
            new ConcurrentDictionary<long, TaskCompletionSource<Dictionary<string, object>>>();

        // Held to start the engine and to write one request to it, so lines never interleave on the pipe.
        // Waiting for it can be given up on: a restart waits for the engine's handshake, which may take the
        // whole start timeout, and every message arriving meanwhile would otherwise block for exactly as long.
        private readonly object _lock = new object();

        private Process _process;
        private StreamWriter _toEngine;
        private long _lastStart;
        private long _lastWarning = Stopwatch.GetTimestamp() - 61 * Stopwatch.Frequency;
        private volatile bool _closed;
        private volatile string _mode;

        public Engine(string name, McpWatchOptions options = null)
        {
            _name = name ?? "mcp-server";
            _options = options ?? McpWatchOptions.Defaults();
            _engineOptions = _options.ToEngineOptions(_name);
            _mode = _options.RequestedMode;
        }

        /// <summary>
        /// The engine for one guarded server, started, or null when MCPWatch is off
        /// (<c>Enabled = false</c> or <c>MCPWATCH_ENABLED=0</c>).
        ///
        /// A guard that can't start its engine is not an error the caller has to handle: it is logged to
        /// stderr, and <c>FailOpen</c> decides what happens to messages until the engine comes up.
        /// </summary>
        public static Engine CreateIfEnabled(string name, McpWatchOptions options = null)
        {
            var settings = options ?? McpWatchOptions.Defaults();
            if (!settings.IsEnabled) return null;
            var engine = new Engine(name, settings);
            try
            {
                engine.Start();
            }
            catch (EngineUnavailableException e)
            {
                var what = settings.IsFailOpen ? "messages pass unchecked" : "requests are refused";
                Log("[mcpwatch] " + e.Message + "; " + what + " until it starts");
            }
            return engine;
        }

        public string Name => _name;

        /// <summary>The mode the engine reported, which with a project key is the dashboard's.</summary>
        public string Mode => _mode;

        /// <summary>True when the guard passes messages through if the engine can't be reached.</summary>
        public bool FailOpen => _options.IsFailOpen;

        private static void Log(string line)
        {
            // stdout belongs to the MCP protocol on a stdio server; the guard only ever writes to stderr.
            try { Console.Error.WriteLine(line); } catch (IOException) { }
        }

        // ---- process -------------------------------------------------------------------------------

        /// <summary>
        /// How to start the engine: the given command, <c>MCPWATCH_ENGINE</c>, <c>mcpwatch</c> on the PATH, else npx.
        /// </summary>
        internal static List<string> EngineCommand(IList<string> configured)
        {
            IList<string> command = configured;
            if (command == null || command.Count == 0)
            {
                var fromEnv = Environment.GetEnvironmentVariable("MCPWATCH_ENGINE");
                if (!string.IsNullOrWhiteSpace(fromEnv)) command = SplitCommand(fromEnv);
            }
            if (command != null && command.Count > 0)
            {
                var o = new List<string>(command) { "engine" };
                return o;
            }
            var found = OnPath("mcpwatch");
            if (found != null) return new List<string> { found, "engine" };
            var npx = OnPath("npx");
            if (npx != null) return new List<string> { npx, "-y", NpmPackage, "engine" };
            throw new EngineUnavailableException(
                "Node.js 20+ is needed: install it, then `npm install -g " + NpmPackage + "`");
        }

        /// <summary>Splits a command line on spaces, keeping quoted paths whole. Backslashes are left alone.</summary>
        internal static List<string> SplitCommand(string command)
        {
            var parts = new List<string>();
            var current = new StringBuilder();
            char quote = '\0';
            var any = false;
            foreach (var c in command)
            {
                if (quote != '\0')
                {
                    if (c == quote) quote = '\0';
                    else current.Append(c);
                }
                else if (c == '"' || c == '\'')
                {
                    quote = c;
                    any = true;
                }
                else if (char.IsWhiteSpace(c))
                {
                    if (any || current.Length > 0)
                    {
                        parts.Add(current.ToString());
                        current.Clear();
                        any = false;
                    }
                }
                else current.Append(c);
            }
            if (any || current.Length > 0) parts.Add(current.ToString());
            return parts;
        }

        private static string OnPath(string program)
        {
            var path = Environment.GetEnvironmentVariable("PATH");
            if (string.IsNullOrEmpty(path)) return null;
            var windows = Path.DirectorySeparatorChar == '\\';
            var names = windows
                ? new[] { program + ".cmd", program + ".exe", program + ".bat", program }
                : new[] { program };
            foreach (var dir in path.Split(Path.PathSeparator))
            {
                if (dir.Length == 0) continue;
                foreach (var candidate in names)
                {
                    try
                    {
                        var file = Path.Combine(dir.Trim('"'), candidate);
                        if (File.Exists(file)) return file;
                    }
                    catch (ArgumentException) { /* a bad PATH entry */ }
                }
            }
            return null;
        }

        /// <summary>Quotes one argument for a Windows command line (CommandLineToArgvW rules).</summary>
        internal static string QuoteArg(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            var sb = new StringBuilder("\"");
            var backslashes = 0;
            foreach (var c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') sb.Append('\\', backslashes * 2 + 1).Append('"');
                else sb.Append('\\', backslashes).Append(c);
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2).Append('"');
            return sb.ToString();
        }

        /// <summary>Starts the engine now rather than on the first message (that one would wait for it).</summary>
        public void Start()
        {
            lock (_lock) EnsureStarted();
        }

        private bool IsRunning
        {
            get
            {
                var p = _process;
                try { return p != null && !p.HasExited; }
                catch (InvalidOperationException) { return false; }
            }
        }

        private Process EnsureStarted()
        {
            if (_closed) throw new EngineUnavailableException("the guard has been closed");
            if (_process != null)
            {
                if (IsRunning) return _process;
                // Don't respawn a crashing engine on every message.
                if (Stopwatch.GetTimestamp() - _lastStart < 10 * Stopwatch.Frequency)
                    throw new EngineUnavailableException("the engine stopped; retrying shortly");
            }
            _lastStart = Stopwatch.GetTimestamp();

            var command = EngineCommand(_options.EngineCommand);
            var args = new StringBuilder();
            for (var i = 1; i < command.Count; i++)
            {
                if (i > 1) args.Append(' ');
                args.Append(QuoteArg(command[i]));
            }
            var info = new ProcessStartInfo(command[0], args.ToString())
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                // The engine logs to stderr; leaving it alone lets it reach the host application's own stderr.
                RedirectStandardError = false,
                CreateNoWindow = true,
                StandardOutputEncoding = new UTF8Encoding(false),
            };
            info.EnvironmentVariables["MCPWATCH_ENGINE_OPTIONS"] = Json.Write(_engineOptions);

            Process started;
            try
            {
                started = Process.Start(info);
            }
            catch (Exception e) when (e is Win32Exception || e is InvalidOperationException || e is IOException)
            {
                throw new EngineUnavailableException("could not start " + command[0] + ": " + e.Message, e);
            }
            if (started == null) throw new EngineUnavailableException("could not start " + command[0]);

            // Anything still waiting belonged to the engine that just died. It gets its own map, so
            // nothing registered against the new engine below can be caught up in failing it.
            var dead = _pending;
            var fresh = new ConcurrentDictionary<long, TaskCompletionSource<Dictionary<string, object>>>();
            _pending = fresh;
            FailPending(dead, new EngineUnavailableException("the engine was restarted"));
            var ready = NewCompletion();
            fresh[0] = ready;
            _process = started;
            _toEngine = new StreamWriter(started.StandardInput.BaseStream, new UTF8Encoding(false)) { NewLine = "\n" };

            var reader = new Thread(() => Read(started, fresh)) { IsBackground = true, Name = "mcpwatch-engine" };
            reader.Start();

            try
            {
                if (!ready.Task.Wait(_options.EffectiveStartTimeout))
                    throw new TimeoutException("no handshake within " + _options.EffectiveStartTimeout.TotalSeconds + " s");
                if (ready.Task.Result.TryGetValue("mode", out var reported) && reported is string m) _mode = m;
            }
            catch (Exception e)
            {
                Kill(started);
                var cause = e is AggregateException ae && ae.InnerException != null ? ae.InnerException : e;
                throw new EngineUnavailableException("the engine did not start: " + cause.Message, cause);
            }
            return started;
        }

        private static TaskCompletionSource<Dictionary<string, object>> NewCompletion() =>
            // Continuations must never run on the reader thread: a caller's code would then hold up every other answer.
            new TaskCompletionSource<Dictionary<string, object>>(TaskCreationOptions.RunContinuationsAsynchronously);

        private static void Kill(Process p)
        {
            try { p.Kill(); } catch (Exception) { /* already gone */ }
        }

        /// <summary>One engine's output, answering only the calls made to that same engine.</summary>
        private static void Read(Process process, ConcurrentDictionary<long, TaskCompletionSource<Dictionary<string, object>>> waiting)
        {
            try
            {
                string line;
                while ((line = process.StandardOutput.ReadLine()) != null)
                {
                    var answer = Json.ParseObject(line);
                    if (answer == null) continue;
                    if (answer.TryGetValue("id", out var id) && id is long n && waiting.TryRemove(n, out var call))
                        call.TrySetResult(answer);
                }
            }
            catch (IOException) { /* the pipe closed; everything waiting is told below */ }
            catch (ObjectDisposedException) { }

            var code = -1;
            try
            {
                process.WaitForExit();
                code = process.ExitCode;
            }
            catch (Exception) { }
            FailPending(waiting, new EngineUnavailableException("the engine exited (code " + code + ")"));
        }

        private static void FailPending(ConcurrentDictionary<long, TaskCompletionSource<Dictionary<string, object>>> waiting, Exception cause)
        {
            foreach (var id in new List<long>(waiting.Keys))
                if (waiting.TryRemove(id, out var call))
                    call.TrySetException(cause);
        }

        /// <summary>Writes one request, starting the engine first if needed. Blocks while the engine starts.</summary>
        private KeyValuePair<long, Task<Dictionary<string, object>>> Send(string op, IDictionary<string, object> fields)
        {
            var wait = _options.EffectiveCallTimeout;
            if (!Monitor.TryEnter(_lock, wait))
            {
                // Another thread is starting the engine and is taking longer than this caller is willing
                // to wait for an answer at all.
                throw new EngineUnavailableException("the engine was busy for " + (int)wait.TotalMilliseconds + " ms");
            }
            try
            {
                EnsureStarted();
                var id = Interlocked.Increment(ref _ids);
                var request = new Dictionary<string, object> { ["id"] = id, ["op"] = op };
                if (fields != null) foreach (var kv in fields) request[kv.Key] = kv.Value;
                var answer = NewCompletion();
                var waiting = _pending;
                waiting[id] = answer;
                try
                {
                    _toEngine.Write(Json.Write(request));
                    _toEngine.Write('\n');
                    _toEngine.Flush();
                }
                catch (Exception e) when (e is IOException || e is ObjectDisposedException)
                {
                    waiting.TryRemove(id, out _);
                    throw new EngineUnavailableException("the engine stopped: " + e.Message, e);
                }
                return new KeyValuePair<long, Task<Dictionary<string, object>>>(id, answer.Task);
            }
            finally
            {
                Monitor.Exit(_lock);
            }
        }

        private static Dictionary<string, object> Checked(Dictionary<string, object> answer)
        {
            if (answer.TryGetValue("error", out var error) && !answer.ContainsKey("forward"))
                throw new EngineUnavailableException(Convert.ToString(error));
            return answer;
        }

        /// <summary>One request to the engine, waited for. Throws when it can't be reached or answers an error.</summary>
        public Dictionary<string, object> Call(string op, IDictionary<string, object> fields = null)
        {
            var sent = Send(op, fields);
            var timeout = _options.EffectiveCallTimeout;
            try
            {
                if (!sent.Value.Wait(timeout))
                {
                    _pending.TryRemove(sent.Key, out _);
                    throw new EngineUnavailableException("the engine did not answer in " + (int)timeout.TotalMilliseconds + " ms");
                }
                return Checked(sent.Value.Result);
            }
            catch (AggregateException e)
            {
                var cause = e.InnerException ?? e;
                throw cause as EngineUnavailableException ?? new EngineUnavailableException(cause.Message, cause);
            }
        }

        /// <summary>
        /// <see cref="Call"/> without blocking the caller's thread (the engine starting still takes a
        /// pool thread). Safe to wait on from classic ASP.NET: nothing here resumes on the caller's context.
        /// </summary>
        public async Task<Dictionary<string, object>> CallAsync(string op, IDictionary<string, object> fields = null)
        {
            KeyValuePair<long, Task<Dictionary<string, object>>> sent;
            if (IsRunning) sent = Send(op, fields);
            else sent = await Task.Run(() => Send(op, fields)).ConfigureAwait(false);

            var timeout = _options.EffectiveCallTimeout;
            using (var cts = new CancellationTokenSource())
            {
                var done = await Task.WhenAny(sent.Value, Task.Delay(timeout, cts.Token)).ConfigureAwait(false);
                if (done != sent.Value)
                {
                    _pending.TryRemove(sent.Key, out _);
                    throw new EngineUnavailableException("the engine did not answer in " + (int)timeout.TotalMilliseconds + " ms");
                }
                cts.Cancel();
            }
            try
            {
                return Checked(await sent.Value.ConfigureAwait(false));
            }
            catch (EngineUnavailableException) { throw; }
            catch (Exception e) { throw new EngineUnavailableException(e.Message, e); }
        }

        /// <summary>
        /// Lets the engine send its queued events and exit.
        ///
        /// Closing its stdin is what tells the engine to flush, and that needs the lock. If a start is in
        /// flight and will not give the lock up promptly, shutting the host application down matters more
        /// than those last queued events, so the engine is simply killed.
        /// </summary>
        public void Dispose()
        {
            _closed = true;
            var held = Monitor.TryEnter(_lock, TimeSpan.FromSeconds(5));
            var running = _process;
            if (running == null || !IsRunning)
            {
                if (held) Monitor.Exit(_lock);
                return;
            }
            if (!held)
            {
                Kill(running);
                return;
            }
            try
            {
                _toEngine.Dispose(); // closing the pipe is what tells the engine to flush
            }
            catch (Exception) { /* it may already be gone */ }
            finally
            {
                Monitor.Exit(_lock);
            }
            try
            {
                if (!running.WaitForExit(5000)) Kill(running);
            }
            catch (Exception) { Kill(running); }
        }

        // ---- checks --------------------------------------------------------------------------------

        private Outcome Failed(Dictionary<string, object> message, Exception cause)
        {
            var now = Stopwatch.GetTimestamp();
            var last = Interlocked.Read(ref _lastWarning);
            // No lock: a check that has already failed must not then wait on a start that may take the
            // whole start timeout, and losing a race here only costs one duplicate log line.
            if (now - last > 60 * Stopwatch.Frequency && Interlocked.CompareExchange(ref _lastWarning, now, last) == last)
                Log("[mcpwatch] guard error: " + cause.Message);

            var isRequest = message != null && message.TryGetValue("id", out var id) && id != null
                            && message.ContainsKey("method");
            if (_options.IsFailOpen || !isRequest) return Outcome.Pass(message);
            return new Outcome(null, new Dictionary<string, object>
            {
                ["jsonrpc"] = "2.0",
                ["id"] = message["id"],
                ["error"] = new Dictionary<string, object>
                {
                    ["code"] = (long)Blocked,
                    ["message"] = "MCPWatch failed closed",
                },
            });
        }

        private static Outcome ToOutcome(Dictionary<string, object> answer)
        {
            answer.TryGetValue("forward", out var forward);
            answer.TryGetValue("reply", out var reply);
            return new Outcome(Json.AsObject(forward), Json.AsObject(reply));
        }

        private static Dictionary<string, object> ClientFields(string session, Dictionary<string, object> message, Dictionary<string, object> http)
        {
            var fields = new Dictionary<string, object> { ["session"] = session, ["msg"] = message };
            if (http != null) fields["http"] = http;
            return fields;
        }

        private static Dictionary<string, object> ServerFields(string session, Dictionary<string, object> message, bool strict) =>
            new Dictionary<string, object> { ["session"] = session, ["msg"] = message, ["strict"] = strict };

        /// <summary>Checks a message on its way from the client to the server. Never throws.</summary>
        public Outcome FromClient(string session, Dictionary<string, object> message, Dictionary<string, object> http = null)
        {
            try { return ToOutcome(Call("client", ClientFields(session, message, http))); }
            catch (Exception e) { return Failed(message, e); }
        }

        /// <summary>Checks a message on its way from the server to the client. Never throws.</summary>
        public Outcome FromServer(string session, Dictionary<string, object> message, bool strict = false)
        {
            try { return ToOutcome(Call("server", ServerFields(session, message, strict))); }
            catch (Exception e) { return Failed(message, e); }
        }

        /// <summary><see cref="FromClient"/> without blocking the caller's thread.</summary>
        public async Task<Outcome> FromClientAsync(string session, Dictionary<string, object> message, Dictionary<string, object> http = null)
        {
            try { return ToOutcome(await CallAsync("client", ClientFields(session, message, http)).ConfigureAwait(false)); }
            catch (Exception e) { return Failed(message, e); }
        }

        /// <summary><see cref="FromServer"/> without blocking the caller's thread.</summary>
        public async Task<Outcome> FromServerAsync(string session, Dictionary<string, object> message, bool strict = false)
        {
            try { return ToOutcome(await CallAsync("server", ServerFields(session, message, strict)).ConfigureAwait(false)); }
            catch (Exception e) { return Failed(message, e); }
        }

        /// <summary>True when a request with no JSON-RPC body (GET, DELETE) must be refused.</summary>
        public bool FromHttp(string session, Dictionary<string, object> http, string method)
        {
            try
            {
                var answer = Call("http", new Dictionary<string, object>
                {
                    ["session"] = session, ["http"] = http, ["method"] = method,
                });
                return answer.TryGetValue("refuse", out var refuse) && refuse is bool b && b;
            }
            catch (Exception e)
            {
                Failed(null, e);
                return !_options.IsFailOpen;
            }
        }

        /// <summary>Session bookkeeping (rename, drop, eventId) that nobody waits for.</summary>
        public void Note(string op, IDictionary<string, object> fields)
        {
            try { Send(op, fields); }
            catch (Exception e) { Failed(null, e); }
        }

        public void RenameSession(string from, string to) =>
            Note("rename", new Dictionary<string, object> { ["from"] = from, ["to"] = to });

        public void DropSession(string session) =>
            Note("drop", new Dictionary<string, object> { ["session"] = session });

        public void NoteEventId(string session, string eventId) =>
            Note("eventId", new Dictionary<string, object> { ["session"] = session, ["eventId"] = eventId });

        /// <summary>Changes the mode at runtime; <c>off</c> passes everything through.</summary>
        public void SetMode(string mode)
        {
            var answer = Call("mode", new Dictionary<string, object> { ["mode"] = mode });
            _mode = answer.TryGetValue("mode", out var reported) && reported is string m ? m : mode;
        }
    }
}
