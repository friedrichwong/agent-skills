# Agent Skills

这个仓库收录我使用和维护的 Agent Skills。

## Skills

### `teach`

基于 Matt Pocock 的 [`teach`](https://github.com/mattpocock/skills/tree/main/skills/productivity/teach) 修改，原项目采用 MIT License。

在原版的多会话教学工作区基础上，增加了更严格的要求：

- 强制建立并持续更新动态学习地图；
- 根据目标、前置条件和掌握证据动态选择下一学习单元；
- 使用明确的状态转换追踪学习进度；
- 只有获得独立完成、迁移或延迟回忆的证据后，才认定为已掌握；
- 显式记录资源覆盖、跳过项、缺口和不确定性。

原作者的 MIT License 保留在 [`teach/LICENSE`](teach/LICENSE)。

### `guide-learning`

这是我自己使用的导学类 Skill。与 `teach` 的完整、多会话教学工作区不同，它更简单、更直接：根据用户目标和当前瓶颈选择最小有效的讲解、练习、反馈与验证动作，不强制生成完整课程工作区。

## License

除单独标注的第三方衍生内容外，本仓库采用 [MIT License](LICENSE)。
