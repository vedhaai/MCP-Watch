using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Vedhaai.MCPWatch
{
    /// <summary>
    /// The guard for one MCP server: an <see cref="Engine"/> plus the ordering rule.
    ///
    /// Hand it every JSON-RPC message that crosses your server, in each direction, and send on what
    /// comes back. Messages of one session in one direction are checked strictly in the order they were
    /// submitted, however long the AI reviewer takes, so a later message never overtakes an earlier one.
    ///
    /// <code>
    /// using (var guard = McpWatchGuard.CreateIfEnabled("my-tools", new McpWatchOptions { ProjectKey = "mw_..." }))
    /// {
    ///     // for each line a client sends:
    ///     Outcome o = await guard.FromClientLineAsync(session, line);
    ///     if (o.ReplyJson != null) WriteToClient(o.ReplyJson);       // a refusal: the tool never runs
    ///     if (o.ForwardJson != null) HandleInYourServer(o.ForwardJson);
    ///
    ///     // for each message your server sends back:
    ///     Outcome r = await guard.FromServerLineAsync(session, json);
    ///     if (r.ForwardJson != null) WriteToClient(r.ForwardJson);   // possibly rewritten or redacted
    /// }
    /// </code>
    /// </summary>
    public sealed class McpWatchGuard : IDisposable
    {
        private const string DefaultName = "mcp-server";

        private readonly ConcurrentDictionary<string, Sequencer> _sequencers = new ConcurrentDictionary<string, Sequencer>();
        private readonly bool _ownsEngine;

        public McpWatchGuard(string name = DefaultName, McpWatchOptions options = null)
            : this(new Engine(name, options), true)
        {
        }

        /// <summary>A guard over an engine you already have, e.g. one shared by several transports. It does not dispose it.</summary>
        public McpWatchGuard(Engine engine) : this(engine, false)
        {
        }

        private McpWatchGuard(Engine engine, bool ownsEngine)
        {
            Engine = engine ?? throw new ArgumentNullException(nameof(engine));
            _ownsEngine = ownsEngine;
        }

        /// <summary>
        /// A guard with its engine started, or null when MCPWatch is off (<c>Enabled = false</c> or
        /// <c>MCPWATCH_ENABLED=0</c>): then your server simply runs untouched.
        /// </summary>
        public static McpWatchGuard CreateIfEnabled(string name = DefaultName, McpWatchOptions options = null)
        {
            var engine = Engine.CreateIfEnabled(name, options);
            return engine == null ? null : new McpWatchGuard(engine, true);
        }

        public Engine Engine { get; }

        /// <summary>The mode in force (with a project key, the dashboard's).</summary>
        public string Mode => Engine.Mode;

        /// <summary>Changes the mode at runtime, with no restart.</summary>
        public void SetMode(string mode) => Engine.SetMode(mode);

        /// <summary>Checks a message on its way from the client to your server, after the ones before it.</summary>
        public Task<Outcome> FromClientAsync(string session, Dictionary<string, object> message, Dictionary<string, object> http = null) =>
            Queue(session, "c").Submit(() => Engine.FromClientAsync(session, message, http));

        /// <summary>Checks a message on its way from your server to the client, after the ones before it.</summary>
        public Task<Outcome> FromServerAsync(string session, Dictionary<string, object> message, bool strict = false) =>
            Queue(session, "s").Submit(() => Engine.FromServerAsync(session, message, strict));

        /// <summary>
        /// <see cref="FromClientAsync"/> for a raw line of JSON. A line that isn't a JSON object is answered
        /// with a JSON-RPC parse error (-32700) or invalid request (-32600) and never reaches your server.
        /// </summary>
        public Task<Outcome> FromClientLineAsync(string session, string json)
        {
            var message = Json.ParseObject(json);
            if (message != null) return FromClientAsync(session, message);
            var parsed = TryParse(json, out var anything);
            return Task.FromResult(new Outcome(null, new Dictionary<string, object>
            {
                ["jsonrpc"] = "2.0",
                ["id"] = null,
                ["error"] = new Dictionary<string, object>
                {
                    ["code"] = parsed && anything != null ? -32600L : -32700L,
                    ["message"] = parsed && anything != null ? "MCPWatch: expected one JSON object per message" : "Parse error",
                },
            }));
        }

        /// <summary>
        /// <see cref="FromServerAsync"/> for a raw line of JSON. A line that isn't a JSON object can't be
        /// checked, so it is dropped (both <c>Forward</c> and <c>Reply</c> are null).
        /// </summary>
        public Task<Outcome> FromServerLineAsync(string session, string json, bool strict = false)
        {
            var message = Json.ParseObject(json);
            return message != null
                ? FromServerAsync(session, message, strict)
                : Task.FromResult(new Outcome(null, null));
        }

        /// <summary>Forget a session's state (its sequencers here, its scores and pins' bookkeeping in the engine). Call when a connection closes.</summary>
        public void DropSession(string session)
        {
            _sequencers.TryRemove(session + "\u0000c", out _);
            _sequencers.TryRemove(session + "\u0000s", out _);
            Engine.DropSession(session);
        }

        private Sequencer Queue(string session, string direction) =>
            _sequencers.GetOrAdd(session + "\u0000" + direction, _ => new Sequencer());

        private static bool TryParse(string json, out object value)
        {
            try { value = Json.Parse(json); return true; }
            catch (FormatException) { value = null; return false; }
        }

        public void Dispose()
        {
            if (_ownsEngine) Engine.Dispose();
        }
    }
}
