require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let urlBase = process.env.SUPABASE_URL || '';
urlBase = urlBase.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(urlBase, supabaseKey);

const upload = multer({ storage: multer.memoryStorage() });

function formatarDataExcel(val) {
    if (!val) return '';
    if (val instanceof Date) {
        const d = String(val.getDate()).padStart(2, '0');
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const y = val.getFullYear();
        return `${d}/${m}/${y}`;
    }
    if (typeof val === 'string' && val.includes('/')) {
        const parts = val.split('/');
        if (parts.length >= 3) {
            let ano = parts[2];
            if (ano.length === 2) ano = `20${ano}`;
            return `${parts[1].padStart(2, '0')}/${parts[0].padStart(2, '0')}/${ano}`;
        }
    }
    return val;
}

function formatarNome(nomeStr) {
    if (!nomeStr) return '';
    const preposicoes = ['da', 'de', 'di', 'do', 'du', 'das', 'dos', 'e'];
    return nomeStr
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .map(palavra => {
            if (preposicoes.includes(palavra)) return palavra;
            return palavra.charAt(0).toUpperCase() + palavra.slice(1);
        })
        .join(' ');
}

// Faxina Automática (Exclui registros vencidos há mais de 7 dias) e Retorna Ordenado
app.get('/autorizacoes', async (req, res) => {
    const { data, error } = await supabase.from('autorizacoes').select('*');
    if (error) return res.status(500).json({ erro: error.message });

    const hoje = new Date();
    const idsParaDeletar = [];
    const dadosExibicao = [];

    data.forEach(reg => {
        const dataBase = reg.fim_autorizacao || reg.data_mensagem;
        
        if (!dataBase) {
            dadosExibicao.push(reg);
            return;
        }

        const partes = String(dataBase).replace(/-/g, '/').split('/');
        if (partes.length >= 3) {
            let [dia, mes, ano] = partes;
            if (ano.length === 2) ano = `20${ano}`;
            
            const dataLimite = new Date(`${ano}-${mes}-${dia}T23:59:59`);
            const dataExclusao = new Date(dataLimite);
            dataExclusao.setDate(dataExclusao.getDate() + 7);

            if (hoje > dataExclusao) {
                idsParaDeletar.push(reg.id);
            } else {
                dadosExibicao.push(reg);
            }
        } else {
            dadosExibicao.push(reg);
        }
    });

    if (idsParaDeletar.length > 0) {
        await supabase.from('autorizacoes').delete().in('id', idsParaDeletar);
    }

    dadosExibicao.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));

    res.json(dadosExibicao);
});

// Cadastro Manual com Substituição Inteligente
app.post('/autorizacoes', async (req, res) => {
    const nova = req.body;
    nova.nome = formatarNome(nova.nome); 
    
    await supabase.from('autorizacoes').delete().ilike('nome', nova.nome);
    
    const { error } = await supabase.from('autorizacoes').insert([nova]);
    if (error) return res.status(500).json({ erro: error.message });
    res.status(201).json({ mensagem: 'Registro salvo com sucesso!' });
});

// Importação com Substituição Inteligente
app.post('/importar', upload.single('planilha'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não localizado.' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const dadosPlanilha = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true });

        if (dadosPlanilha.length === 0) return res.status(400).json({ erro: 'Planilha vazia.' });

        const mapaNomes = new Map();
        
        dadosPlanilha.forEach(linha => {
            const linhaNormalizada = {};
            for (let chave in linha) {
                let chaveLimpa = chave.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                linhaNormalizada[chaveLimpa] = linha[chave];
            }

            const nomeBruto = linhaNormalizada['NOME'];
            if (nomeBruto) {
                const nomeFormatado = formatarNome(nomeBruto); 
                let valorDataRaw = linhaNormalizada['DATA DA MENSAGEM'] || linhaNormalizada['DATA MENSAGEM'] || linhaNormalizada['DATA'];
                
                mapaNomes.set(nomeFormatado, {
                    data_mensagem: formatarDataExcel(valorDataRaw),
                    nome: nomeFormatado,
                    inicio_autorizacao: formatarDataExcel(linhaNormalizada['INÍCIO'] || linhaNormalizada['INICIO']),
                    fim_autorizacao: formatarDataExcel(linhaNormalizada['FIM']),
                    empresa: linhaNormalizada['EMPRESA'],
                    local_autorizacao: linhaNormalizada['LOCAL'],
                    formato_envio: linhaNormalizada['FORMATO'] || linhaNormalizada['FORMATO ENVIO']
                });
            }
        });

        const listaParaProcessar = Array.from(mapaNomes.values());
        let importados = 0;

        for (const reg of listaParaProcessar) {
            await supabase.from('autorizacoes').delete().ilike('nome', reg.nome);
            await supabase.from('autorizacoes').insert([reg]);
            importados++;
        }

        res.status(201).json({ mensagem: `Processamento concluído!\n• ${importados} registros atualizados.` });
    } catch (err) {
        console.error("Erro importação:", err);
        res.status(500).json({ erro: 'Falha durante o processamento.', detalhe: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Sistema operando na porta ${PORT}`);
});