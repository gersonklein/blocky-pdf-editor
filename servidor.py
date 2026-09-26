"""Servidor local do Blocky PDF Editor.

O `python -m http.server` puro nao envia nenhum cabecalho de cache. Sem ele o
Chrome guarda `app.js`/`style.css` heuristicamente e continua executando uma
versao antiga depois de o arquivo mudar no disco -- inclusive versoes que
quebravam o boot e deixavam o botao "Abrir PDF" sem efeito. Aqui todo arquivo
sai com `no-store`, entao um F5 sempre pega o codigo atual.
"""

import io
import json
import os
import sys
import threading
import urllib.request
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# --- Leitura em voz alta (Piper TTS, voz pt_BR do Edresson) -----------------
# A voz roda aqui no servidor, nao no navegador: o modelo tem ~60 MB e o
# onnxruntime nativo sintetiza bem mais rapido que a versao WASM. O modelo e
# baixado uma vez para `vozes/` na primeira leitura.
VOZ = "pt_BR-edresson-low"
VOZ_URL = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
    "pt/pt_BR/edresson/low/" + VOZ
)
PASTA_VOZES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vozes")
MAX_CARACTERES = 5000  # por requisicao; o app manda o texto em pedacos

_voz = None
_voz_lock = threading.Lock()


def _baixar_voz():
    os.makedirs(PASTA_VOZES, exist_ok=True)
    for ext in (".onnx.json", ".onnx"):
        destino = os.path.join(PASTA_VOZES, VOZ + ext)
        if os.path.exists(destino):
            continue
        print(f"Baixando voz {VOZ}{ext}...")
        temp = destino + ".parcial"
        urllib.request.urlretrieve(VOZ_URL + ext, temp)
        os.replace(temp, destino)


def carregar_voz():
    """Carrega a voz uma vez so. Lanca RuntimeError com mensagem legivel."""
    global _voz
    with _voz_lock:
        if _voz is not None:
            return _voz
        try:
            from piper import PiperVoice
        except ImportError:
            raise RuntimeError(
                "Piper TTS nao instalado. Rode: py -3 -m pip install piper-tts"
            )
        try:
            _baixar_voz()
        except Exception as err:
            raise RuntimeError(f"Nao foi possivel baixar a voz {VOZ}: {err}")
        _voz = PiperVoice.load(os.path.join(PASTA_VOZES, VOZ + ".onnx"))
        return _voz


def _precarregar_voz():
    try:
        carregar_voz()
        print(f"Voz {VOZ} pronta.", flush=True)
    except Exception as err:  # noqa: BLE001 -- so informa; o /tts repete o erro
        print(f"[AVISO] Leitura em voz alta indisponivel: {err}", flush=True)


def sintetizar_wav(texto):
    voz = carregar_voz()
    buf = io.BytesIO()
    # Uma sintese por vez: o modelo e compartilhado entre as threads.
    with _voz_lock, wave.open(buf, "wb") as wav:
        voz.synthesize_wav(texto, wav)
    return buf.getvalue()


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

    def _responder(self, status, corpo, tipo):
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def _erro_json(self, status, msg):
        corpo = json.dumps({"erro": msg}, ensure_ascii=False).encode("utf-8")
        self._responder(status, corpo, "application/json; charset=utf-8")

    def do_POST(self):
        if self.path.split("?")[0] != "/tts":
            self._erro_json(404, "Rota inexistente.")
            return
        try:
            tamanho = int(self.headers.get("Content-Length") or 0)
            dados = json.loads(self.rfile.read(tamanho) or b"{}")
            texto = str(dados.get("texto") or "").strip()
        except (ValueError, json.JSONDecodeError):
            self._erro_json(400, "Corpo invalido: esperado JSON {texto}.")
            return
        if not texto:
            self._erro_json(400, "Texto vazio.")
            return
        if len(texto) > MAX_CARACTERES:
            self._erro_json(413, f"Texto maior que {MAX_CARACTERES} caracteres.")
            return
        try:
            wav = sintetizar_wav(texto)
        except RuntimeError as err:
            self._erro_json(503, str(err))
            return
        except Exception as err:  # noqa: BLE001 -- vira mensagem para o app
            self._erro_json(500, f"Falha na sintese: {err}")
            return
        self._responder(200, wav, "audio/wav")


def main():
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
    diretorio = sys.argv[2] if len(sys.argv) > 2 else "."
    handler = partial(NoCacheHandler, directory=diretorio)
    with ThreadingHTTPServer(("127.0.0.1", porta), handler) as httpd:
        print(f"Servindo {diretorio} em http://127.0.0.1:{porta}/")
        # Carregar a voz leva ~2,5 s: feito ja na subida, o primeiro "Ouvir"
        # nao paga essa espera. Falhar aqui nao impede o resto do app.
        threading.Thread(target=_precarregar_voz, daemon=True).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor encerrado.")


if __name__ == "__main__":
    main()
