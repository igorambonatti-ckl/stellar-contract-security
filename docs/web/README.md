# Relatório de auditoria — app React

Mesma stack do ChainGuard: **React 19 + Vite 6 + TypeScript + Tailwind 3 +
react-router 7 + lucide-react**. O `tailwind.config.js` e o `src/index.css` são
copiados **literalmente** de `apps/web` do ChainGuard, então as classes
utilitárias (`card`, `tag-blue`, `btn-primary`, `bg-grid`, `section-label`) são
as mesmas — não uma reimplementação parecida.

```bash
cd docs/web
npm install
npm run dev      # servidor de desenvolvimento
npm run build    # -> dist/index.html, arquivo único
```

## Rotas

| Rota | Conteúdo |
|---|---|
| `/` | Resumo: a tese e as três métricas lado a lado |
| `/matriz` | Detecção por seed, e os seis erros de medição |
| `/achados` | Os seis achados, expansíveis, e as limitações |
| `/metodo` | As sete etapas, marcando onde o humano não é opcional |

## Duas decisões que valem explicar

**Build em arquivo único.** `vite-plugin-singlefile` inlina JS e CSS no
`index.html`. O relatório é publicado atrás de um CSP que bloqueia todo host
externo, então assets irmãos não carregariam.

**`HashRouter`, não `BrowserRouter`.** Sem servidor que faça fallback de rota
para o index, `/matriz` daria 404 ao recarregar.

## Dados

Tudo em [`src/data.ts`](src/data.ts), transcrito de
`04-prototype-development/results/`. Nada é gerado em tempo de execução — é um
relatório de uma campanha que já rodou, não um painel ao vivo.
