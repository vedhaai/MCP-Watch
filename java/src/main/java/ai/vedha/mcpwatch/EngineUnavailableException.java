package ai.vedha.mcpwatch;

/**
 * The engine could not be started, reached, or answered in time.
 *
 * <p>Guards catch this themselves: {@code failOpen} decides whether the message is passed on or the
 * request refused. It reaches your code only from {@link Engine#start()}.
 */
public class EngineUnavailableException extends RuntimeException {

	private static final long serialVersionUID = 1L;

	public EngineUnavailableException(String message) {
		super(message);
	}

	public EngineUnavailableException(String message, Throwable cause) {
		super(message, cause);
	}
}
