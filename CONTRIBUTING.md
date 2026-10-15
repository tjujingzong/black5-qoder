# 贡献指南

感谢你对"挤黑五"项目的关注！欢迎参与改进。

## 如何贡献

### 1. Fork 并克隆

```bash
# Clone 你 fork 的仓库
git clone https://github.com/YOUR_USERNAME/black5-qoder.git
cd black5-qoder

# 创建开发分支
git checkout -b feature/your-feature-name
```

### 2. 本地开发

```bash
# 启动本地开发服务器
npm run dev

# 运行类型检查
npm run check
```

### 3. 提交更改

```bash
git add .
git commit -m "feat: 添加新功能描述"
git push origin feature/your-feature-name
```

### 4. 创建 Pull Request

在你的 fork 上创建 Pull Request，描述清楚:
- 修改的目的和内容
- 相关的 Issue 编号 (如果有)
- 测试方法

## 开发规范

### Git 提交消息格式

我们使用约定式提交 (Conventional Commits):

- `feat:` - 新功能
- `fix:` - Bug 修复
- `docs:` - 文档变更
- `style:` - 代码格式调整
- `refactor:` - 重构
- `chore:` - 构建/工具相关
- `test:` - 测试相关

示例:
```bash
git commit -m "feat: 支持语音聊天断开重连"
git commit -m "fix: 修正房间过期后无法进入的问题"
```

### 代码风格

#### JavaScript

- 使用 ES Modules
- 采用驼峰命名 (camelCase)
- 避免全局变量
- 注释清晰明了

#### 文件组织

```
public/
├── js/           # 业务逻辑模块
│   ├── main.js   # 入口文件
│   ├── voice.js  # 特定功能独立成模块
│   └── ...
├── css/          # 样式
└── assets/       # 静态资源
```

### 测试建议

在提交前请至少进行以下测试:

1. **基础功能测试**
   - 创建/加入房间正常
   - 游戏流程完整
   - 语音功能可用 (如果有改动)

2. **兼容性测试**
   - Chrome、Firefox、Safari、Edge 等主流浏览器
   - 移动端和桌面端

3. **性能测试**
   - 长时间运行无明显卡顿
   - 内存占用合理

## 常见问题

### Q: 我的 PR 一直没被合并怎么办？

A: 请确保:
- 已经解决冲突
- 通过了所有检查
- 有清晰的描述和测试说明
- 等待维护者 review (通常需要 1-3 天)

### Q: 如何运行本地测试？

A: 
```bash
npm run dev
```

然后访问 `http://localhost:3000`

### Q: 修改了后端代码需要注意什么？

A: 
- 确保不破坏现有 API 契约
- 新增字段要在 `normalize()` 中做初始化
- 删除字段前先确认是否还有其他地方在使用
- 及时更新 `dev/migration.sql`

## 反馈和建议

如果你有功能建议或遇到问题，欢迎通过以下方式联系我们:

- 提交 Issue (详细说明问题复现步骤)
- 讨论区 (适合开放性讨论)

---

**再次感谢你的贡献!** 🎉
