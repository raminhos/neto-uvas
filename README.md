# Leitor de Excel e recomendação de compatibilidade

Aplicação React para abrir arquivos `.xlsx` e `.xlsm` no navegador, visualizar e editar células, preencher células vazias da aba `Matriz` com recomendações e baixar uma cópia atualizada do Excel.

Os arquivos selecionados são processados localmente no navegador.

## Requisitos

- Node.js 20 ou superior
- npm

## Executar

```bash
npm install
npm run dev
```

O Vite informa o endereço local da aplicação. Para gerar uma versão de produção:

```bash
npm run build
npm run preview
```

## Usar o leitor

1. Abra um arquivo `.xlsx` ou `.xlsm`.
2. Selecione a aba desejada no menu.
3. Dê duplo clique em uma célula para editar; `Enter` ou sair do campo salva, e `Esc` cancela.
4. Em arquivos que contenham uma aba `Matriz`, escolha o método e ajuste os parâmetros.
5. Clique em **Preencher** para estimar as células vazias. O botão **Resetar** restaura a matriz ao estado do arquivo carregado.
6. Clique em **Baixar Excel** para salvar uma cópia com as recomendações e edições manuais.

O método `KronRLS-MKL` precisa que o mesmo arquivo também contenha as abas `Copas` e `Porta-enxertos`.

## Planilhas de exemplo

Os arquivos em [`docs/`](./docs/) são exemplos para testar o leitor e o preenchimento de compatibilidade.
