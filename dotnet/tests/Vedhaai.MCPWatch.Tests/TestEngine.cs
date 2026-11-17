using System;
using System.Collections.Generic;
using System.IO;
using Vedhaai.MCPWatch;
using Xunit;

namespace Vedhaai.MCPWatch.Tests
{
    /// <summary>
    /// Starts the real Node engine for the tests, so they check actual verdicts rather than a stand-in.
    ///
    /// The engine is this repository's own build (<c>engine/dist/cli.js</c>). Without it the tests that
    /// need verdicts are skipped rather than failed, so the .NET package can be built on its own.
    /// </summary>
    internal static class TestEngine
    {
        public static string EngineScript()
        {
            // Walk up from the test binaries to the repository root.
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null)
            {
                var candidate = Path.Combine(dir.FullName, "engine", "dist", "cli.js");
                if (File.Exists(candidate)) return candidate;
                dir = dir.Parent;
            }
            return null;
        }

        public static Engine Start(string mode, out string tempDir, Action<McpWatchOptions> configure = null)
        {
            var script = EngineScript();
            tempDir = Path.Combine(Path.GetTempPath(), "mcpwatch-dotnet-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            var options = new McpWatchOptions
            {
                Mode = mode,
                // No project key: nothing is reported to a dashboard and nothing is fetched from one.
                EventsFile = Path.Combine(tempDir, "events.jsonl"),
                PinsFile = Path.Combine(tempDir, "pins.json"),
                RegistryFile = Path.Combine(tempDir, "registry.json"),
                EngineCommand = new[] { "node", script },
                StartTimeout = TimeSpan.FromSeconds(60),
                CallTimeout = TimeSpan.FromSeconds(30),
            };
            configure?.Invoke(options);
            var engine = new Engine("dotnet-test", options);
            engine.Start();
            return engine;
        }

        public static Dictionary<string, object> Request(object id, string method, Dictionary<string, object> p) =>
            new Dictionary<string, object> { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = p };

        public static Dictionary<string, object> ToolCall(object id, string tool, Dictionary<string, object> args) =>
            Request(id, "tools/call", new Dictionary<string, object> { ["name"] = tool, ["arguments"] = args });

        public static Dictionary<string, object> TextResult(object id, string text) =>
            new Dictionary<string, object>
            {
                ["jsonrpc"] = "2.0",
                ["id"] = id,
                ["result"] = new Dictionary<string, object>
                {
                    ["content"] = new List<object>
                    {
                        new Dictionary<string, object> { ["type"] = "text", ["text"] = text },
                    },
                },
            };

        public static long ErrorCode(Dictionary<string, object> reply) =>
            (long)((Dictionary<string, object>)reply["error"])["code"];

        public static List<object> Rules(Dictionary<string, object> reply)
        {
            var error = (Dictionary<string, object>)reply["error"];
            var data = (Dictionary<string, object>)error["data"];
            return (List<object>)data["rules"];
        }
    }

    /// <summary>A fact that is skipped when the repository's engine hasn't been built.</summary>
    public sealed class EngineFactAttribute : FactAttribute
    {
        public EngineFactAttribute()
        {
            if (TestEngine.EngineScript() == null)
                Skip = "engine/dist/cli.js is missing: run `npm run build -w engine` in the repository root";
        }
    }
}
