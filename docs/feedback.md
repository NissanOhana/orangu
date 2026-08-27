# Beta feedback

Run `orangu feedback --context session|repo|global|report|app` to open the beta feedback form on `127.0.0.1`. Its launched URL contains a fresh process capability and should remain private while the command runs. The regular `orangu serve` app also exposes a **Beta feedback** launcher.

The standalone command deliberately starts with an empty, process-specific session root and an in-memory empty suggestion store. It does not discover or attach a session, repository aggregate, global aggregate, or report. Feedback text is entered in the browser, not in CLI arguments or terminal history.

The form builds one exact preview from user-entered fields and these displayed diagnostics only:

- Orangu version
- Node major version
- OS family
- architecture
- selected context
- `localhost` surface

Reviewing the preview enables a separate acknowledgement. Any edit invalidates that review. The explicit send button opens GitHub's issue composer and therefore sends the reviewed prefill to GitHub; GitHub still requires its own final Submit action. Orangu does not call the GitHub API, `gh`, analytics, a beacon, or another submission endpoint.

Long feedback is never truncated. If its encoded composer URL exceeds Orangu's conservative limit, the form keeps the complete Markdown available to copy and offers a blank GitHub issue instead.

Offline HTML reports retain their zero-network policy. Their CLI workflow may suggest `orangu feedback --context report`, but GitHub URLs and interactive feedback code exist only in the localhost serve bundle.
