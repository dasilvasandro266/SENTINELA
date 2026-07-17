import { database, ref, onValue } from './firebase-config.js';

//BOTÃO DA TOOLBAR
document.addEventListener('DOMContentLoaded', () => {
  const menuButton = document.querySelector('.menu-button');
  const toolbarMenu = document.querySelector('.toolbar-menu');
  if (menuButton) {
    menuButton.addEventListener('click', () => {
      toolbarMenu.classList.toggle('active');
    });
  }
});

// Referência ao nó "Sumários"
const sumariosRef = ref(database, 'Sumários');
// Container na página
const sumarioContainer = document.querySelector('.Sumário-container');

// Cria a lista de sumários
function criarSumarioContainer(sumarioTitulo, dados) {
  const container = document.createElement('div');
  container.classList.add('sumario-item');
  container.textContent = sumarioTitulo;

  container.addEventListener('click', () => {
    exibirDetalhesSumario(sumarioTitulo, dados);
  });

  sumarioContainer.appendChild(container);
}

// Exibe vídeos de um sumário
function exibirDetalhesSumario(sumarioTitulo, dados) {
  sumarioContainer.innerHTML = '';
  const h2 = document.createElement('h2');
  h2.textContent = sumarioTitulo;
  sumarioContainer.appendChild(h2);

  const detalhesContainer = document.createElement('div');
  detalhesContainer.classList.add('detalhes-sumario');

  Object.keys(dados).forEach(videoKey => {
    const info = dados[videoKey];

    const item = document.createElement('div');
    item.classList.add('detalhes-item');

    // Ao clicar, abre player.html passando sumário e chave do vídeo
    if (info.link) {
      item.addEventListener('click', () => {
        const url = `player.html?sumario=${encodeURIComponent(sumarioTitulo)}&video=${encodeURIComponent(videoKey)}`;
        window.open(url, '_blank');
      });
    }

    // thumbnail
    const thumb = document.createElement('img');
    thumb.src = info.thumbnail || 'default-thumbnail.jpg';
    thumb.alt = info.título ? `Thumbnail de ${info.título}` : 'Thumbnail';
    item.appendChild(thumb);

    // título do vídeo
    const tituloEl = document.createElement('h3');
    tituloEl.textContent = info.título || 'Título não disponível';
    item.appendChild(tituloEl);

    // instrutor
    const instrutorEl = document.createElement('p');
    instrutorEl.textContent = `Instrutor: ${info.instrutor || 'Desconhecido'}`;
    item.appendChild(instrutorEl);

    detalhesContainer.appendChild(item);
  });

  sumarioContainer.appendChild(detalhesContainer);

  // botão voltar
  const btnVoltar = document.createElement('button');
  btnVoltar.classList.add('btn-sumario');
  btnVoltar.textContent = 'Voltar';
  btnVoltar.addEventListener('click', carregarSumarios);
  sumarioContainer.appendChild(btnVoltar);
}

// Carrega a lista de sumários
function carregarSumarios() {
  onValue(sumariosRef, snapshot => {
    sumarioContainer.innerHTML = '';
    const sumarios = snapshot.val();
    if (sumarios) {
      Object.keys(sumarios).forEach(key => {
        criarSumarioContainer(key, sumarios[key]);
      });
    } else {
      sumarioContainer.textContent = 'Nenhum sumário disponível';
    }
  });
}

// Inicia
carregarSumarios();