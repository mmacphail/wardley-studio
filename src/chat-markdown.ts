import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, breaks: true });

// Replies are untrusted content. Only explicit web links may leave the app,
// and image syntax must never cause background network requests.
markdown.validateLink = (href) => {
  try {
    return ["https:", "http:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
};
markdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  _env,
  renderer,
) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  markdown.utils.escapeHtml(
    renderer.renderInlineAsText(tokens[index].children ?? [], options, env),
  );

export function renderChatMarkdown(text: string): string {
  return markdown.render(text);
}
