// Voz Piper rodando inteira no navegador (WebAssembly), para quando não há o
// servidor.py por trás — a versão publicada no GitHub Pages, por exemplo.
//
// As peças, todas com versão fixa (uma versão "latest" do onnxruntime já
// quebrou a combinação JS + WASM de uma biblioteca pronta que testamos):
//  - piper_phonemize (espeak-ng compilado para WASM): texto → fonemas;
//  - onnxruntime-web: roda o modelo da voz, fonemas → áudio;
//  - a voz pt_BR-edresson-low, do repositório oficial rhasspy/piper-voices.
//
// Tudo (~90 MB) é baixado uma vez com progresso e guardado no sistema de
// arquivos privado do navegador (OPFS); das próximas vezes carrega do disco.
// (O Cache Storage chegou a falhar com "Unexpected internal error" num perfil
// do Chrome enquanto o OPFS funcionava, e o OPFS lida melhor com 60 MB.)

const VOZ = "pt_BR-edresson-low";
const VOZ_URL =
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/edresson/low/" + VOZ;
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const PIPER_JS =
  "https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-o91UDS6e.js";
const PIPER_WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize";
const PASTA = "blocky-voz-v1"; // no OPFS; mudar o nome força baixar de novo

// Tamanhos aproximados: só para a barra andar de forma honesta enquanto o
// servidor ainda não mandou o Content-Length (ou se não mandar).
const ARQUIVOS = [
  { chave: "modelo", url: VOZ_URL + ".onnx", bytes: 63104526 },
  { chave: "config", url: VOZ_URL + ".onnx.json", bytes: 4168 },
  { chave: "espeak", url: PIPER_WASM_BASE + ".data", bytes: 18077249 },
  { chave: "phonWasm", url: PIPER_WASM_BASE + ".wasm", bytes: 635212 },
  { chave: "ortWasm", url: ORT_BASE + "ort-wasm-simd-threaded.wasm", bytes: 11210254 },
];

let prontoPromise = null;
let estado = null; // { ort, sessao, config, phonemize }
// Quem acompanha a carga: a preparação silenciosa (na seleção) e o clique
// podem pedir a mesma carga; os dois recebem o progresso.
const ouvintes = new Set();
let ultimoProgresso = null;

async function pastaLocal() {
  try {
    const raiz = await navigator.storage.getDirectory();
    return await raiz.getDirectoryHandle(PASTA, { create: true });
  } catch (_) {
    return null; // sem OPFS (navegador antigo, aba anônima): baixa sempre
  }
}

async function baixar(arq, pasta, aoAvancar) {
  if (pasta) {
    try {
      const arquivo = await (await pasta.getFileHandle(arq.chave)).getFile();
      if (arquivo.size > 0) {
        aoAvancar(arquivo.size, arquivo.size, true);
        return arquivo.arrayBuffer();
      }
    } catch (_) {
      /* ainda não baixado */
    }
  }

  const res = await fetch(arq.url);
  if (!res.ok) throw new Error(`Falha ao baixar ${arq.url.split("/").pop()} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("Content-Length")) || arq.bytes;
  const partes = [];
  let recebido = 0;
  const leitor = res.body.getReader();
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    recebido += value.length;
    aoAvancar(recebido, Math.max(total, recebido), false);
  }
  const blob = new Blob(partes);
  if (pasta) {
    // createWritable grava num rascunho e só troca no close(): uma aba
    // fechada no meio não deixa arquivo pela metade.
    try {
      const w = await (await pasta.getFileHandle(arq.chave, { create: true })).createWritable();
      await w.write(blob);
      await w.close();
    } catch (err) {
      console.warn("[voz] não foi possível guardar", arq.chave, err);
    }
  }
  return blob.arrayBuffer();
}

// Baixa (ou lê do disco) e inicializa tudo. `aoProgresso(fracao, rotulo,
// bytesFeitos, bytesTotais)` recebe fracao 0..1. Chamadas repetidas
// reaproveitam a mesma carga.
export function preparar(aoProgresso) {
  if (aoProgresso) {
    ouvintes.add(aoProgresso);
    if (ultimoProgresso) aoProgresso(...ultimoProgresso);
  }
  if (!prontoPromise) {
    const avisar = (...args) => {
      ultimoProgresso = args;
      for (const f of ouvintes) f(...args);
    };
    prontoPromise = carregar(avisar).catch((err) => {
      prontoPromise = null; // deixa tentar de novo
      throw err;
    });
    prontoPromise
      .finally(() => {
        ouvintes.clear();
        ultimoProgresso = null;
      })
      .catch(() => {});
  }
  return prontoPromise;
}

// true se os arquivos já estão no disco: carregar é rápido e não gasta rede.
export async function baixada() {
  try {
    const pasta = await (await navigator.storage.getDirectory()).getDirectoryHandle(PASTA);
    for (const a of ARQUIVOS) {
      if (!(await (await pasta.getFileHandle(a.chave)).getFile()).size) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function carregar(aoProgresso) {
  const recebidos = {};
  const totais = {};
  let tudoDoCache = true;
  const totalGeral = () => ARQUIVOS.reduce((s, a) => s + (totais[a.chave] || a.bytes), 0);
  const avisar = () => {
    const feito = ARQUIVOS.reduce((s, a) => s + (recebidos[a.chave] || 0), 0);
    // Os últimos 5% ficam para compilar o WASM e abrir o modelo.
    aoProgresso(
      (feito / totalGeral()) * 0.95,
      tudoDoCache ? "Carregando a voz..." : "Baixando a voz (só na primeira vez)...",
      feito,
      totalGeral()
    );
  };
  avisar();

  const bufs = {};
  const pasta = await pastaLocal();
  await Promise.all(
    ARQUIVOS.map(async (a) => {
      bufs[a.chave] = await baixar(a, pasta, (rec, tot, doCache) => {
        recebidos[a.chave] = rec;
        totais[a.chave] = tot;
        if (!doCache) tudoDoCache = false;
        avisar();
      });
    })
  );

  aoProgresso(0.96, "Preparando a voz...");
  const ort = await import(ORT_BASE + "ort.wasm.min.mjs");
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.wasmBinary = bufs.ortWasm;
  // Várias threads exigem página "cross-origin isolated", o que o GitHub
  // Pages não é; pedir mesmo assim só gera aviso no console.
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;
  const sessao = await ort.InferenceSession.create(new Uint8Array(bufs.modelo), {
    executionProviders: ["wasm"],
  });
  const config = JSON.parse(new TextDecoder().decode(bufs.config));

  const { createPiperPhonemize } = await import(PIPER_JS);
  estado = {
    ort,
    sessao,
    config,
    phonemize: { criar: createPiperPhonemize, wasm: bufs.phonWasm, dados: bufs.espeak },
  };

  // Uma síntese de aquecimento: a primeira execução de verdade compila
  // caminhos internos do onnxruntime e sairia bem mais lenta.
  aoProgresso(0.99, "Aquecendo a voz...");
  await sintetizarJa("Olá.");
  aoProgresso(1, "Voz pronta.");
}

// O piper_phonemize é um programa de linha de comando compilado: cada chamada
// monta uma instância nova e roda o main(). Os bytes do WASM e do espeak-ng
// já estão em memória, então nada é baixado de novo.
function fonemas(texto) {
  const { criar, wasm, dados } = estado.phonemize;
  return new Promise((resolve, reject) => {
    let saida = null;
    criar({
      noInitialRun: true, // o main() roda só no callMain, com os argumentos
      wasmBinary: wasm,
      getPreloadedPackage: () => dados,
      locateFile: (nome) =>
        nome.endsWith(".wasm") ? PIPER_WASM_BASE + ".wasm" : PIPER_WASM_BASE + ".data",
      print: (linha) => {
        if (saida === null) saida = linha;
      },
      printErr: () => {},
    })
      .then((mod) => {
        mod.callMain([
          "-l",
          estado.config.espeak.voice,
          "--input",
          JSON.stringify([{ text: texto }]),
          "--espeak_data",
          "/espeak-ng-data",
        ]);
        if (saida === null) throw new Error("O fonemizador não respondeu.");
        resolve(JSON.parse(saida).phonemes);
      })
      .catch(reject);
  });
}

// Fonemas → ids pela tabela da própria voz, como o Piper em Python faz: "^",
// cada fonema seguido do "_" de enchimento, "$". O fonemizador WASM também
// devolve ids, mas pela tabela padrão de 256 símbolos — esta voz tem 130, e
// um id fora dela derruba o onnxruntime. Fonema que a voz não conhece (o
// til solto "̃", por exemplo) é descartado, igual ao Python.
function idsDosFonemas(lista) {
  const mapa = estado.config.phoneme_id_map;
  const ids = [...mapa["^"], ...mapa["_"]];
  for (const f of lista) {
    if (!mapa[f]) continue;
    ids.push(...mapa[f], ...mapa["_"]);
  }
  ids.push(...mapa["$"]);
  return ids;
}

// Uma síntese por vez: a sessão do onnxruntime não aceita run() simultâneo.
let fila = Promise.resolve();

// texto → { taxa, amostras: Float32Array }. Só depois de preparar().
export async function sintetizar(texto) {
  if (!prontoPromise) throw new Error("A voz ainda não foi carregada.");
  await prontoPromise;
  return sintetizarJa(texto);
}

function sintetizarJa(texto) {
  const tarefa = fila.then(async () => {
    const { ort, sessao, config } = estado;
    const ids = idsDosFonemas(await fonemas(texto));
    const inf = config.inference || {};
    const feeds = {
      input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor(
        "float32",
        Float32Array.from([inf.noise_scale ?? 0.667, inf.length_scale ?? 1, inf.noise_w ?? 0.8]),
        [3]
      ),
    };
    if (config.num_speakers > 1) {
      feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
    }
    const saida = await sessao.run(feeds);
    return { taxa: config.audio.sample_rate, amostras: saida.output.data };
  });
  fila = tarefa.catch(() => {});
  return tarefa;
}

export function pronta() {
  return !!estado;
}
