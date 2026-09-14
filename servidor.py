"""Servidor local do Blocky PDF Editor.

O `python -m http.server` puro nao envia nenhum cabecalho de cache. Sem ele o
Chrome guarda `app.js`/`style.css` heuristicamente e continua executando uma
versao antiga depois de o arquivo mudar no disco -- inclusive versoes que
quebravam o boot e deixavam o botao "Abrir PDF" sem efeito. Aqui todo arquivo
sai com `no-store`, entao um F5 sempre pega o codigo atual.
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # O 304 tambem faz o navegador reusar o corpo em cache: responde sempre 200.
    def send_header(self, keyword, value):
        if keyword.lower() == "last-modified":
            return
        super().send_header(keyword, value)


def main():
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    diretorio = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = partial(NoCacheHandler, directory=diretorio)
    with ThreadingHTTPServer(("127.0.0.1", porta), handler) as httpd:
        print(f"Servindo {diretorio} em http://127.0.0.1:{porta}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor encerrado.")


if __name__ == "__main__":
    main()
