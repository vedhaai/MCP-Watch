using System;
using System.Collections.Generic;

namespace Vedhaai.MCPWatch
{
    /// <summary>
    /// Settings for one guarded server, as the Node middleware's options.
    ///
    /// Everything is optional. What you leave out comes from the <c>MCPWATCH_*</c> environment
    /// variables, which the engine reads itself, exactly as for a Node, Python or Java server. With a
    /// project key, the project's settings in the dashboard win over both, and reach the guard within 5 seconds.
    /// <code>
    /// new McpWatchOptions { ProjectKey = "mw_...", Mode = "enforce", DenyTools = new[] { "run_command" } }
    /// </code>
    /// </summary>
    public sealed class McpWatchOptions
    {
        /// <summary>The project key from the dashboard: events go to that project and its settings apply live.</summary>
        public string ProjectKey { get; set; }

        /// <summary>The dashboard URL (default <c>http://127.0.0.1:9100</c>).</summary>
        public string Server { get; set; }

        /// <summary><c>off</c>, <c>observe</c>, <c>protect</c> or <c>enforce</c>.</summary>
        public string Mode { get; set; }

        /// <summary>False turns the guard off: the server runs untouched. <c>MCPWATCH_ENABLED=0</c> does the same.</summary>
        public bool? Enabled { get; set; }

        /// <summary>
        /// What to do when the engine can't be reached: false (the default, as in the Node engine) refuses
        /// requests with a JSON-RPC error, true passes messages through unchecked.
        /// </summary>
        public bool? FailOpen { get; set; }

        /// <summary>Tools that may never be called (MW009).</summary>
        public IEnumerable<string> DenyTools { get; set; }

        /// <summary>If set, only these tools may be called.</summary>
        public IEnumerable<string> AllowTools { get; set; }

        /// <summary>HTTP: the web origins allowed to call the server (MW030).</summary>
        public IEnumerable<string> AllowedOrigins { get; set; }

        /// <summary>HTTP: the host names the server answers to (default: not checked).</summary>
        public IEnumerable<string> AllowedHosts { get; set; }

        /// <summary>HTTP: refuse requests with no <c>Authorization</c> or <c>X-API-Key</c> header (MW031).</summary>
        public bool? RequireAuth { get; set; }

        /// <summary>HTTP: refuse JWT bearer tokens whose <c>aud</c> doesn't include this (MW036).</summary>
        public string ExpectedAudience { get; set; }

        public int? WindowSeconds { get; set; }
        public int? ThrottleAt { get; set; }
        public int? BlockAt { get; set; }
        public int? MaxCallsPerWindow { get; set; }
        public int? MaxArgBytes { get; set; }
        public int? MaxResultBytes { get; set; }

        public string EventsFile { get; set; }
        public string PinsFile { get; set; }
        public string RegistryFile { get; set; }

        /// <summary>Turns the AI reviewer on with its defaults (local Ollama, <c>qwen2.5:7b</c>). Ignored if <see cref="Ai"/> is set.</summary>
        public bool? AiEnabled { get; set; }

        /// <summary>The AI reviewer's settings: <c>enabled</c>, <c>url</c>, <c>model</c>, <c>apiKey</c>, …</summary>
        public IDictionary<string, object> Ai { get; set; }

        /// <summary>Clients to block, overriding the rules in every mode.</summary>
        public IEnumerable<string> BlockClients { get; set; }

        /// <summary>Clients to always allow, overriding the rules in every mode.</summary>
        public IEnumerable<string> AllowClients { get; set; }

        /// <summary>
        /// How to start the engine, when it isn't <c>mcpwatch</c> on the PATH and <c>MCPWATCH_ENGINE</c> isn't set.
        /// The <c>engine</c> argument is added for you, e.g. <c>new[] { "node", @"C:\mcpwatch\engine\dist\cli.js" }</c>.
        /// </summary>
        public IList<string> EngineCommand { get; set; }

        /// <summary>How long to wait for the engine to start (default 120 s). The first run may fetch it with npx.</summary>
        public TimeSpan? StartTimeout { get; set; }

        /// <summary>How long to wait for one message to be checked (default 60 s).</summary>
        public TimeSpan? CallTimeout { get; set; }

        /// <summary>Any option the engine takes, by its own name, for settings this class has no property for.</summary>
        public IDictionary<string, object> Extra { get; } = new Dictionary<string, object>();

        /// <summary>Options with nothing set: everything comes from the environment and the dashboard.</summary>
        public static McpWatchOptions Defaults() => new McpWatchOptions();

        // ---- what the engine and the Engine class read ---------------------------------------------

        internal bool IsEnabled =>
            Enabled ?? Environment.GetEnvironmentVariable("MCPWATCH_ENABLED") != "0";

        internal bool IsFailOpen => FailOpen ?? false;

        internal TimeSpan EffectiveStartTimeout => StartTimeout ?? TimeSpan.FromSeconds(120);

        internal TimeSpan EffectiveCallTimeout => CallTimeout ?? TimeSpan.FromSeconds(60);

        /// <summary>The mode asked for in code or the environment, before the engine reports its own.</summary>
        internal string RequestedMode
        {
            get
            {
                if (!string.IsNullOrEmpty(Mode)) return Mode;
                var fromEnv = Environment.GetEnvironmentVariable("MCPWATCH_MODE");
                return string.IsNullOrEmpty(fromEnv) ? "enforce" : fromEnv;
            }
        }

        /// <summary>The options as the engine's <c>MCPWATCH_ENGINE_OPTIONS</c> payload.</summary>
        internal Dictionary<string, object> ToEngineOptions(string name)
        {
            var o = new Dictionary<string, object> { ["name"] = name };
            Put(o, "key", ProjectKey);
            Put(o, "server", Server);
            Put(o, "mode", Mode);
            Put(o, "failOpen", FailOpen);
            PutList(o, "denyTools", DenyTools);
            PutList(o, "allowTools", AllowTools);
            PutList(o, "allowedOrigins", AllowedOrigins);
            PutList(o, "allowedHosts", AllowedHosts);
            Put(o, "requireAuth", RequireAuth);
            Put(o, "expectedAudience", ExpectedAudience);
            Put(o, "windowSeconds", WindowSeconds);
            Put(o, "throttleAt", ThrottleAt);
            Put(o, "blockAt", BlockAt);
            Put(o, "maxCallsPerWindow", MaxCallsPerWindow);
            Put(o, "maxArgBytes", MaxArgBytes);
            Put(o, "maxResultBytes", MaxResultBytes);
            Put(o, "eventsFile", EventsFile);
            Put(o, "pinsFile", PinsFile);
            Put(o, "registryFile", RegistryFile);
            if (Ai != null) o["ai"] = new Dictionary<string, object>(Ai);
            else if (AiEnabled.HasValue) o["ai"] = new Dictionary<string, object> { ["enabled"] = AiEnabled.Value };
            if (BlockClients != null || AllowClients != null)
            {
                o["clients"] = new Dictionary<string, object>
                {
                    ["block"] = new List<string>(BlockClients ?? new string[0]),
                    ["allow"] = new List<string>(AllowClients ?? new string[0]),
                };
            }
            foreach (var kv in Extra)
                if (kv.Value != null) o[kv.Key] = kv.Value;
            return o;
        }

        private static void Put(Dictionary<string, object> o, string key, object value)
        {
            if (value != null) o[key] = value;
        }

        private static void PutList(Dictionary<string, object> o, string key, IEnumerable<string> value)
        {
            if (value != null) o[key] = new List<string>(value);
        }
    }
}
