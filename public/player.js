import { database, ref, get } from './firebase-config.js';

// Pega os parâmetros da URL
function getParam(param) {
    const urlParams = new URLSearchParams(window.location.search);
    return decodeURIComponent(urlParams.get(param) || '');
}

const sumarioId = getParam('sumario');     // Nome do sumário
const videoId = getParam('video');         // Chave do vídeo dentro do sumário

console.log('sumarioId =', sumarioId);
console.log('videoId =', videoId);

if (!sumarioId || !videoId) {
    alert('Informações do vídeo não encontradas na URL.');
} else {
    const videoRef = ref(database, `Sumários/${sumarioId}/${videoId}`);

    get(videoRef).then(snapshot => {
        if (snapshot.exists()) {
            const dados = snapshot.val();
            document.getElementById('titulo').textContent = dados.título || 'Sem título';
            document.getElementById('instrutor').textContent = `Instrutor: ${dados.instrutor || 'Desconhecido'}`;
            document.getElementById('video').src = dados.link;
            document.getElementById('video').poster = dados.thumbnail || '';
        } else {
            document.getElementById('titulo').textContent = 'Vídeo não encontrado';
        }
    }).catch(error => {
        console.error('Erro ao buscar dados do Firebase:', error);
    });
}