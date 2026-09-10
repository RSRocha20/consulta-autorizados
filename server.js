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

// Converte qualquer data (YYYY-MM-DD, Excel Serial, Date, etc) para DD/MM/AAAA
function formatarDataParaExibicao(val) {
    if (!val) return '';
    if (val instanceof Date) {
        const d = String(val.getDate()).padStart(2, '0');
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const y = val.getFullYear();
        return `${d}/${m}/${y}`;
    }
    let strVal = String(val).trim();
    // Se veio do input type="date" (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
        const [y, m, d] = strVal.split('-');
        return `${d}/${m}/${y}`;
    }
    // Se já está em DD/MM/YYYY
    if (strVal.includes('/')) {
        const parts = strVal.split('/');
        if (parts.length >= 3) {
            let ano = parts[2];
            if (ano.length === 2) ano = `20${ano}`;
            return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${ano}`;
        }
    }
    return strVal;
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

// Faxina Automática e Retorna Ordenado
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

        let partes = [];
        if (String(dataBase).includes('-')) {
            const p = dataBase.split('-');
            if (p.length === 3) partes = [p[2], p[1], p[0]]; // Converte yyyy-mm-dd para dd/mm/yyyy para checagem
        } else {
            partes = String(dataBase).replace(/-/g, '/').split('/');
        }

        if (partes.length >= 3) {
            let [dia, mes, ano] = partes;
            if (ano && ano.length === 2) ano = `20${ano}`;
            
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

// Cadastro Manual
app.post('/autorizacoes', async (req, res) => {
    const nova = req.body;
    nova.nome = formatarNome(nova.nome); 
    nova.data_mensagem = formatarDataParaExibicao(nova.data_mensagem);
    nova.inicio_autorizacao = formatarDataParaExibicao(nova.inicio_autorizacao);
    nova.fim_autorizacao = formatarDataParaExibicao(nova.fim_autorizacao);
    
    await supabase.from('autorizacoes').delete().ilike('nome', nova.nome);
    
    const { error } = await supabase.from('autorizacoes').insert([nova]);
    if (error) return res.status(500).json({ erro: error.message });
    res.status(201).json({ mensagem: 'Registro salvo com sucesso!' });
});

// Atualizar Registro Específico
app.put('/autorizacoes/:id', async (req, res) => {
    const { id } = req.params;
    const atualizado = req.body;
    atualizado.nome = formatarNome(atualizado.nome);
    atualizado.data_mensagem = formatarDataParaExibicao(atualizado.data_mensagem);
    atualizado.inicio_autorizacao = formatarDataParaExibicao(atualizado.inicio_autorizacao);
    atualizado.fim_autorizacao = formatarDataParaExibicao(atualizado.fim_autorizacao);

    const { error } = await supabase.from('autorizacoes').update(atualizado).eq('id', id);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ mensagem: 'Registro atualizado com sucesso!' });
});

// Deletar Registro Específico
app.delete('/autorizacoes/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('autorizacoes').delete().eq('id', id);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ mensagem: 'Registro removido com sucesso!' });
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
                    data_mensagem: formatarDataParaExibicao(valorDataRaw),
                    nome: nomeFormatado,
                    inicio_autorizacao: formatarDataParaExibicao(linhaNormalizada['INÍCIO'] || linhaNormalizada['INICIO']),
                    fim_autorizacao: formatarDataParaExibicao(linhaNormalizada['FIM']),
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