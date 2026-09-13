const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function main() {
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const out = path.join(root, 'release', `fluid-design-reference-${version}`);
  await fs.mkdir(out, { recursive: true });
  for (const file of ['accessibility.css', 'fluid-motion.js', 'liquid-glass.js', 'fluid-design.css', 'design-reference.css', 'design-reference.js']) await fs.copyFile(path.join(root, 'src', file), path.join(out, file));
  await fs.copyFile(path.join(root, 'src/design-reference.html'), path.join(out, 'index.html'));
  await fs.copyFile(path.join(root, 'docs/apple-design-reference.md'), path.join(out, 'DESIGN.md'));
  await fs.copyFile(path.join(root, 'docs/desktop-interaction.md'), path.join(out, 'DESKTOP.md'));
  await fs.mkdir(path.join(out, 'examples'), { recursive: true });
  for (const file of ['desktop-interaction.js', 'window-state.cjs']) await fs.copyFile(path.join(root, 'src', file), path.join(out, 'examples', file));
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  await fs.writeFile(path.join(out, 'README.md'), `# Fluid ${version}\n\n解压后用现代 Chrome 或 Edge 打开 index.html。无需安装依赖。\n\n三个章节可体验真实背景折射、可打断的弹簧动效、来源展开弹窗与稳定阅读表面。玻璃透镜支持鼠标拖动、方向键与 Enter 归位，弹窗支持 Esc。右上角可切换深浅色与减少动态效果。\n\n共享实现为 fluid-motion.js、liquid-glass.js、fluid-design.css。设计原则、参数、技术边界与测试说明见 DESIGN.md。这里的同名文件位于当前目录，而非文档中介绍的仓库 src 目录。\n\n本项目为 MIT 许可的独立实现，参考 Apple 公开设计资料，不是 Apple 官方组件或逐像素复刻。\n`);
  console.log(out);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
