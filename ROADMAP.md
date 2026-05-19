# puppet-show — roadmap

## Status atual
Phases 1, 2, 3 e 4 entregues e validadas no Windows. Dashboard HTML cobre drift/alert/runtime visualmente. `topHistorical` agora é tokenizado. Próximos ciclos são hardening / UX, não novos eixos.

## Decisões de design (não reverter sem motivo forte)
- enforcement default: warn (não strict)
- auto-strict promove a strict em paths sensíveis
- contrato YAML explícito (não prosa parseada)
- zero deps npm — só node:sqlite builtin
- scoring: tool_not_allowed=30, scope_out=40, scope_in=20, section=10, evidence=15, findings_evidence_missing=8, section_too_short=5, drift=0 (informacional)
- Phase 3 correlação puppet↔contrato: lookup por session_id, fallback por cwd + recência (10 min). Heurística — documentada no README.
- alert threshold: env var `PUPPET_SHOW_ALERT_BELOW` (default 70), exposta também em `/api/stats` para que o snapshot do dashboard renderize alert sem depender só de stream events
- drift detail string ("contract diverged from prior run: a, b, c") é fonte de verdade — o store parseia de volta em array de campos. Acoplamento entre formato da string e parser é deliberado: evita coluna nova no schema.
- `topHistorical` faz tokenização em JS sobre pool de até 200 candidatos ordenados por score. Evita SQL com WHERE dinâmico variável e mantém portabilidade.

## Em andamento
- (nada)

## Phase 2 — Evidence parsing rico ✓
- [x] Citações por finding (`findings_evidence_missing`, peso 8)
- [x] Checks de conteúdo por seção (`min_words_per_section` opcional, gera `section_too_short` peso 5)
- [x] Alerts quando score < threshold (env `PUPPET_SHOW_ALERT_BELOW`, default 70; flag no stream event, badge no CLI, badge no HTML)

## Phase 3 — Runtime enforcement ✓
- [x] Hook `PreToolUse:Read|Write|Edit|Grep|Glob|Bash|WebFetch|NotebookEdit` → `hooks/puppet-runtime.js`
- [x] Bloquear (strict) com JSON `{"decision":"block","reason":...}` ou injetar warning (warn) em scope/tool violation
- [x] Mecanismo de "contrato ativo": lookup no SQLite por session_id e fallback cwd+recência via `store.findOpenDispatchForRuntime`
- [x] Override global via `PUPPET_SHOW_ENFORCE=strict`

## Phase 4 — Memória de orquestração ✓
- [x] Indexar briefings por score histórico (`store.topHistorical` tokenizado, `store.statsByPuppetType`)
- [x] Sugerir reuso via `/puppet-show:suggest <query>` (`dashboard/cli-suggest.js`)
- [x] Detectar drift entre dispatches semelhantes — evento `drift` no stream, violation `drift` informacional no DB, e parse do detail de volta em array no `listRecent`
- [x] `/puppet-show:history` com agregados por puppet_type e top reused titles (`dashboard/cli-history.js`)
- [x] Skill `briefing` atualizada com seções "Reusing proven contracts" e "Drift"

## Dashboard HTML ✓
- [x] Alert badge (vermelho pulsante) renderizado quando score < alert_below — funciona tanto pra stream events quanto pro snapshot via `/api/recent`
- [x] Drift chip ("⤳ drift: scope_in, tools") na meta row dos cards
- [x] Indicador visual sutil no título quando há drift (↗ superscript plum)
- [x] Border-left vermelho em cards com alert
- [x] Violations separadas por stage (return / runtime / drift) com cores diferentes e prefixos (⚠ / ⛔ / ⤳)
- [x] Stage tag em cada violation
- [x] Tool name mostrado em violations runtime
- [x] Timeline ganha kinds `drift` e `runtime_violation` com cores próprias
- [x] Novos filter buttons: `alert`, `drift`
- [x] Modal `yamlify` mostra `min_words_per_section` e marca `auto-strict`

## Backlog / próximos ciclos
- [ ] Apagar pasta `{.claude-plugin,hooks,dashboard,skills` — persistentemente travada por outro processo no Windows (provavelmente Explorer ou shell antigo); o user pode tentar após fechar janelas que visitaram a pasta, ou após reboot. Conteúdo dela é vazio (entulho de extração de zip com brace expansion literal).
- [ ] Considerar coluna `drift_changed` (TEXT JSON) na tabela `dispatches` em vez de parsear de violation detail — só faz sentido se precisarmos consultar drift por campo
- [ ] `--json` mode em cli-audit / cli-history / cli-suggest pra integrar com outros tools
- [ ] Pesos das violations configuráveis via env (hoje só hardcoded em VIOLATION_WEIGHTS)
- [ ] `cli-suggest --limit=N` aceita N=0 (já valida >0, mas mensagem poderia ser mais clara)

## Log de mudanças
- 2026-05-19: Phase 1 entregue. Bugs cross-platform identificados.
- 2026-05-19: Cross-platform fixes — `store.close()`, `dashboard/start.js` e `stop.js` (PID file idempotente), slash commands reescritos como one-liners node, E2E validado no Windows.
- 2026-05-19: Phase 2 entregue — `findings_evidence_missing` (peso 8), `section_too_short` (peso 5), `min_words_per_section` no return_format, env `PUPPET_SHOW_ALERT_BELOW` (default 70), alert badge no cli-audit, 5 novos testes (18/18 passando).
- 2026-05-19: Phase 3 entregue — `hooks/puppet-runtime.js` com lookup por session_id + fallback cwd+recência, settings.json registra matcher `Read|Write|Edit|Grep|Glob|Bash|WebFetch|NotebookEdit`, strict bloqueia via JSON `{"decision":"block"}`, warn loga violation stage='runtime'.
- 2026-05-19: Phase 4 entregue — drift detection no PreToolUse:Task, `cli-history.js` com agregados, `cli-suggest.js` com lookup, novos slash commands `/puppet-show:history` e `/puppet-show:suggest`, skill `briefing` atualizada.
- 2026-05-19: Dashboard HTML completo — alert badge pulsante, drift chip plum, violations coloridas por stage (return/runtime/drift), border-left dos cards reage a alert, filters novos `alert` e `drift`, timeline ganha kinds próprios pra drift e runtime_violation, modal mostra stage por violation. `/api/stats` agora expõe `alert_below`. `listRecent` parseia drift de volta em array de campos.
- 2026-05-19: `topHistorical` reescrita — tokeniza query em palavras, busca em title+puppet_type+briefing, ranqueia por número de tokens matchados depois por score. Query "audit lifecycle" agora encontra "Audit session lifecycle".
- 2026-05-19: E2E completo validado — dashboard renderiza alert/drift/runtime corretamente via stream events E via snapshot reload. 18/18 contract tests + store test passando. Pasta entulho persistentemente travada — adiada pro user.
