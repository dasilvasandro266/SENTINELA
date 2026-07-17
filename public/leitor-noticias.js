import { database, ref, get, auth, onAuthStateChanged } from './firebase-config.js';

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('noticia-container');
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    container.innerHTML = "<p>Notícia não encontrada.</p>";
    return;
  }

  onAuthStateChanged(auth, user => {
    if (user) {
      const noticiaRef = ref(database, `noticias/${id}`);
      get(noticiaRef)
        .then(snapshot => {
          if (snapshot.exists()) {
            const noticia = snapshot.val();
            const titulo = noticia.titulo || "Sem título";
            const dataUpload = noticia.upload || "Data desconhecida";
            const fontes = noticia.fontes || "Fonte não informada";
            const conteudoObj = noticia.conteudo || {};

            // Ordenar parágrafos por chave numérica
            const paragrafosOrdenados = Object.keys(conteudoObj)
  .sort((a, b) => Number(a) - Number(b))
  .map(chave => `<p>${conteudoObj[chave]}</p>`)
  .join('');

            container.innerHTML = `
              <div class="noticia-header">
                <span class="upload-data"> ${dataUpload}</span>
              </div>
              <h1>${titulo}</h1>
              ${paragrafosOrdenados}
              <div class="noticia-footer">
                <p><strong>Fonte:</strong> ${fontes}</p>
              </div>
            `;
          } else {
            container.innerHTML = "<p>Notícia não encontrada.</p>";
          }
        })
        .catch(error => {
          console.error('Erro ao carregar notícia:', error);
          container.innerHTML = "<p>Erro ao carregar notícia.</p>";
        });
    } else {
      container.innerHTML = "<p>É necessário estar autenticado para ver esta notícia.</p>";
    }
  });
});