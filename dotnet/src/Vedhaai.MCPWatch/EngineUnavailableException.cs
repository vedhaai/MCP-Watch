using System;

namespace Vedhaai.MCPWatch
{
    /// <summary>The MCPWatch engine could not be started or did not answer.</summary>
    public sealed class EngineUnavailableException : Exception
    {
        public EngineUnavailableException(string message) : base(message) { }

        public EngineUnavailableException(string message, Exception inner) : base(message, inner) { }
    }
}
