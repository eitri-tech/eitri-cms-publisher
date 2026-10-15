# Eitri CMS Publisher

Extensão Chrome (Manifest V3) para publicar e exportar sections no VTEX CMS (`vtex.admin-cms`) direto da aba do editor, sem precisar montar a request na mão.

## Como funciona

- Um content script roda na página do editor (`.../admin/(app/)new-cms/<builder>/<page>/edit/<id>`) e "escuta" passivamente as chamadas GraphQL que o próprio editor já faz, capturando `builderId`, `documentId`, `documentVersionId` e as sections atualmente carregadas.
- O painel lateral (side panel) deixa você:
  - **Exportar** as sections capturadas como JSON (copia para o clipboard), para reutilizar em outra conta.
  - **Importar** um JSON de sections e escolher:
    - **REPLACE**: substitui todas as sections atuais pelo JSON de entrada.
    - **ADD**: mantém as sections atuais e anexa o JSON de entrada no final.
- Ao aplicar, a extensão dispara a mesma mutation `PublishByReleases` (persisted query) usada pelo próprio VTEX, executada no contexto da página — os cookies de sessão vão automaticamente, sem precisar copiar cookie/token.

## Instalar (modo desenvolvedor)

1. Abra `chrome://extensions`.
2. Ative "Modo do desenvolvedor" (canto superior direito).
3. Clique em "Carregar sem compactação" e selecione esta pasta (`eitri-cms-publisher`).
4. Abra (ou recarregue) a aba do editor VTEX CMS que você quer publicar.

## Atualizar

No topo do painel, clique em **"Verificar atualização"**. Se houver release novo, clique em **"Atualizar agora"**: na primeira vez, selecione a pasta onde a extensão está carregada (a que contém o `manifest.json`); a extensão baixa o zip do release, sobrescreve os arquivos e se recarrega sozinha.

## Publicar uma versão (mantenedores)

Suba a versão em `manifest.json`, faça commit/push e então `git tag X.Y.Z && git push origin X.Y.Z`. O GitHub Actions valida a tag contra o manifest e cria o release com o zip.

## Usar

1. Com a aba do editor aberta, clique no ícone da extensão — o painel lateral abre à direita. Ele permanece aberto mesmo que você interaja com a página.
2. Confira os campos `builderId` / `pageType` / `documentId` / `documentVersionId` — devem preencher sozinhos. Se aparecerem vazios, clique em **"Recarregar página & sincronizar"**.
3. Veja a lista de sections atuais capturadas (confirma que a extensão "enxergou" o estado certo).
4. Para **exportar**: clique em **"Copiar JSON"** — as sections capturadas são copiadas para o clipboard em formato amigável, prontas para colar em outra instância da extensão.
5. Para **importar**: cole o JSON de entrada (aceita tanto um array de sections `[{ "name": "...", "data": {...} }]` quanto um objeto `{ "sections": [...] }`).
6. Escolha REPLACE ou ADD.
7. Clique em **"Aplicar no CMS"** e confirme no diálogo — a publicação é imediata.
8. O log no rodapé mostra a resposta da API.

## Formato do JSON

Cada section pode vir em formato "amigável":

```json
{ "id": "opcional", "name": "AnnouncementBar", "data": { ...props da section... } }
```

O `id`, se omitido, é gerado automaticamente. O formato já "empacotado" (`{"data":{"id","name","props","errors"}}`) também é aceito.

O botão **"Copiar JSON"** exporta no formato amigável — o JSON copiado pode ser colado diretamente no campo de entrada da extensão em outra conta.

## Observações

- A extensão só ganha acesso a `*.myvtex.com`.
- Nada é enviado para fora do navegador: a extensão só fala com a própria aba do CMS.
- `documentVersionId` precisa ser o da versão carregada no editor — por isso, se você acabou de abrir/editar a página fora dessa aba, use "Recarregar página & sincronizar" antes de aplicar.
- O painel lateral se re-sincroniza automaticamente ao trocar de aba.
