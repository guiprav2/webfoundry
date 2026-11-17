import { esc } from './util.js';

export let defaultHead = ({ title } = {}) =>`<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <script>
    // rootPrefix is the project's base URL, so the runtime loads from pages at any depth.
    window.rootPrefix = /^\\/(files|preview)\\//.test(location.pathname) ? location.pathname.split('/').slice(0, 4).join('/') : '/';
    for (let [src, module] of [['webfoundry/ifdesigner.js', true], ['webfoundry/head.js', false]]) {
      let s = document.createElement('script');
      s.src = rootPrefix.replace(/\\/$/, '') + '/' + src;
      module ? (s.type = 'module') : (s.async = false);
      document.head.append(s);
    }
  </script>
</head>`;

export let defaultHtml = opt =>`<!doctype html>
<html>
  ${defaultHead(opt)}
  <body class="flex flex-col [&>div:first-child]:flex-1 min-h-screen" style="display: none">
    <div>
      <div class="bu box tw m-8">
        <div class="tw p-16 text-center font-sm italic">Start building!</div>
      </div>
    </div>
  </body>
</html>
`;

export function defaultCtrl(path) {
  let name = path.split('/').at(-1);
  let i = name.indexOf('.');
  if (i > 0) name = name.slice(0, i);
  return `export default class ${name} {
  state = {};
  actions = {};
};
`;
}
