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

const SENHA_ADMIN = 'bgkfrcamara26';

app.post('/verificar-admin', (req, res) => {
    const { senha } = req.body;
    if (senha === SENHA_ADMIN) res.json({ sucesso: true });
    else res.json({ sucesso: false });
});

let urlBase = process.env.SUPABASE_URL || '';
urlBase = urlBase.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(urlBase, supabaseKey);

const upload = multer({ storage: multer.memoryStorage() });

function formatarDataParaExibicao(val) {
    if (!val) return '';
    if (val instanceof Date) {
        const d = String(val.getDate()).padStart(2, '0');
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const y = val.getFullYear();
        return `${d}/${m}/${y}`;
    }
    let strVal = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
        const [y, m, d] = strVal.split('-');
        return `${d}/${m}/${y}`;
    }
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

function converterParaDate(dataStr) {
    if (!dataStr) return null;
    let partes = [];
    if (String(dataStr).includes('-')) {
        const p = dataStr.split('-');
        if (p.length === 3) partes = [p[2], p[1], p[0]];
    } else {
        partes = String(dataStr).replace(/-/g, '/').split('/');
    }
    if (partes.length >= 3) {
        let [dia, mes, ano] = partes;
        if (ano && ano.length === 2) ano = `20${ano}`;
        const d = new Date(`${ano}-${mes}-${dia}T00:00:00`);
        return isNaN(d.getTime()) ? null : d;
    }
    return null;
}

function formatarNome(nomeStr) {
    if (!nomeStr) return '';
    const preposicoes = ['da', 'de', 'di', 'do', 'du', 'das', 'dos', 'e'];
    return nomeStr.toLowerCase().trim().split(/\s+/).map(palavra => {
        if (preposicoes.includes(palavra)) return palavra;
        return palavra.charAt(0).toUpperCase() + palavra.slice(1);
    }).join(' ');
}

// --- ROTAS DE AUTORIZADOS ---
app.get('/autorizacoes', async (req, res) => {
    const { data, error } = await supabase.from('autorizacoes').select('*');
    if (error) return res.status(500).json({ erro: error.message });

    const hoje = new Date();
    const idsParaDeletar = [];
    const dadosExibicao = [];

    data.forEach(reg => {
        const dataBase = reg.fim_autorizacao || reg.data_mensagem;
        if (!dataBase) { dadosExibicao.push(reg); return; }
        const d = converterParaDate(dataBase);
        if (d) {
            const dataExclusao = new Date(d);
            dataExclusao.setDate(dataExclusao.getDate() + 7);
            if (hoje > dataExclusao) idsParaDeletar.push(reg.id);
            else dadosExibicao.push(reg);
        } else { dadosExibicao.push(reg); }
    });

    if (idsParaDeletar.length > 0) await supabase.from('autorizacoes').delete().in('id', idsParaDeletar);
    dadosExibicao.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
    res.json(dadosExibicao);
});

app.post('/autorizacoes', async (req, res) => {
    const nova = req.body;
    nova.nome = formatarNome(nova.nome); 
    nova.data_mensagem = formatarDataParaExibicao(nova.data_mensagem);
    nova.inicio_autorizacao = formatarDataParaExibicao(nova.inicio_autorizacao);
    nova.fim_autorizacao = formatarDataParaExibicao(nova.fim_autorizacao);
    
    let query = supabase.from('autorizacoes').select('*').ilike('nome', nova.nome);
    if (nova.empresa) query = query.ilike('empresa', nova.empresa);
    if (nova.local_autorizacao) query = query.ilike('local_autorizacao', nova.local_autorizacao);

    const { data: existentes } = await query;
    const novaDataFim = converterParaDate(nova.fim_autorizacao);

    if (existentes && existentes.length > 0) {
        let deveInserir = true;
        for (const reg of existentes) {
            const df = converterParaDate(reg.fim_autorizacao);
            if (df && novaDataFim && novaDataFim <= df) { deveInserir = false; break; }
        }
        if (!deveInserir) return res.status(400).json({ erro: 'Já existe um cadastro ativo com data fim igual ou mais longa.' });
        await supabase.from('autorizacoes').delete().in('id', existentes.map(r => r.id));
    }

    const { error } = await supabase.from('autorizacoes').insert([nova]);
    if (error) return res.status(500).json({ erro: error.message });
    res.status(201).json({ mensagem: 'Autorizado salvo com sucesso!' });
});

app.put('/autorizacoes/:id', async (req, res) => {
    const { id } = req.params;
    const atualizado = req.body;
    atualizado.nome = formatarNome(atualizado.nome);
    atualizado.data_mensagem = formatarDataParaExibicao(atualizado.data_mensagem);
    atualizado.inicio_autorizacao = formatarDataParaExibicao(atualizado.inicio_autorizacao);
    atualizado.fim_autorizacao = formatarDataParaExibicao(atualizado.fim_autorizacao);

    const { error } = await supabase.from('autorizacoes').update(atualizado).eq('id', id);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ mensagem: 'Atualizado com sucesso!' });
});

app.delete('/autorizacoes/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('autorizacoes').delete().eq('id', id);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ mensagem: 'Removido com sucesso!' });
});

// --- ROTAS DE EVENTOS ---
app.get('/eventos', async (req, res) => {
    const { data, error } = await supabase.from('eventos').select('*');
    if (error) return res.status(500).json({ erro: error.message });

    const hoje = new Date();
    const idsParaDeletar = [];
    const dadosExibicao = [];

    data.forEach(reg => {
        const dataBase = reg.fim_evento || reg.data_mensagem;
        if (!dataBase) { dadosExibicao.push(reg); return; }
        const d = converterParaDate(dataBase);
        if (d) {
            const dataExclusao = new Date(d);
            dataExclusao.setDate(dataExclusao.getDate() + 7);
            if (hoje > dataExclusao) idsParaDeletar.push(reg.id);
            else dadosExibicao.push(reg);
        } else { dadosExibicao.push(reg); }
    });

    if (idsParaDeletar.length > 0) await supabase.from('eventos').delete().in('id', idsParaDeletar);
    dadosExibicao.sort((a, b) => (a.nome_evento || '').localeCompare(b.nome_evento || ''));
    res.json(dadosExibicao);
});

app.post('/eventos', async (req, res) => {
    const nova = req.body;
    nova.nome_evento = formatarNome(nova.nome_evento);
    nova.data_mensagem = formatarDataParaExibicao(nova.data_mensagem);
    nova.inicio_evento = formatarDataParaExibicao(nova.inicio_evento);
    nova.fim_evento = formatarDataParaExibicao(nova.fim_evento);

    const { data: existentes } = await supabase.from('eventos').select('*').ilike('nome_evento', nova.nome_evento).ilike('local_evento', nova.local_evento);
    const novaDataFim = converterParaDate(nova.fim_evento);

    if (existentes && existentes.length > 0) {
        let deveInserir = true;
        for (const reg of existentes) {
            const df = converterParaDate(reg.fim_evento);
            if (df && novaDataFim && novaDataFim <= df) { deveInserir = false; break; }
        }
        if (!deveInserir) return res.status(400).json({ erro: 'Já existe um evento ativo com data fim igual ou mais longa para este local.' });
        await supabase.from('eventos').delete().in('id', existentes.map(r => r.id));
    }

    const { error } = await supabase.from('eventos').insert([nova]);
    if (error) return res.status(500).json({ erro: error.message });
    res.status(201).json({ mensagem: 'Evento salvo com sucesso!' });
});

app.put('/eventos/:id', async (req, res) => {
    const { id } = req.params;
    const atualizado = req.body;
    atualizado.nome_evento = formatarNome(atualizado.nome_evento);
    atualizado.data_mensagem = formatarDataParaExibicao(atualizado.data_mensagem);
    atualizado.inicio_evento = formatarDataParaExibicao(atualizado.inicio_evento);
    atualizado.fim_evento = formatarDataParaExibicao(atualizado.fim_evento);

    const { error } = await supabase.from('eventos').update(atualizado).eq('id', id);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ mensagem: 'Evento atualizado com sucesso!' });
});

app.delete('/eventos/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('eventos').delete().eq('id', id);
    if (error) return res.status(500).json({ erro: error.message });
    res.json({ mensagem: 'Evento removido com sucesso!' });
});

// Importação Planilha de Autorizados
app.post('/importar', upload.single('planilha'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não localizado.' });
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const dadosPlanilha = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true });
        if (dadosPlanilha.length === 0) return res.status(400).json({ erro: 'Planilha vazia.' });

        const { data: todosAtuais } = await supabase.from('autorizacoes').select('*');
        let importados = 0, ignorados = 0;

        for (const linha of dadosPlanilha) {
            const linhaNormalizada = {};
            for (let chave in linha) {
                let chaveLimpa = chave.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                linhaNormalizada[chaveLimpa] = linha[chave];
            }
            const nomeBruto = linhaNormalizada['NOME'];
            if (!nomeBruto) continue;

            const novoReg = {
                data_mensagem: formatarDataParaExibicao(linhaNormalizada['DATA DA MENSAGEM'] || linhaNormalizada['DATA MENSAGEM'] || linhaNormalizada['DATA']),
                nome: formatarNome(nomeBruto),
                inicio_autorizacao: formatarDataParaExibicao(linhaNormalizada['INÍCIO'] || linhaNormalizada['INICIO']),
                fim_autorizacao: formatarDataParaExibicao(linhaNormalizada['FIM']),
                empresa: linhaNormalizada['EMPRESA'] ? String(linhaNormalizada['EMPRESA']).trim() : '',
                local_autorizacao: linhaNormalizada['LOCAL'] ? String(linhaNormalizada['LOCAL']).trim() : '',
                formato_envio: linhaNormalizada['FORMATO'] || linhaNormalizada['FORMATO ENVIO'] || 'Mensagem'
            };

            const novaDataFim = converterParaDate(novoReg.fim_autorizacao);
            const conflitos = todosAtuais.filter(r => 
                r.nome.toLowerCase() === novoReg.nome.toLowerCase() &&
                (r.empresa || '').toLowerCase() === (novoReg.empresa || '').toLowerCase() &&
                (r.local_autorizacao || '').toLowerCase() === (novoReg.local_autorizacao || '').toLowerCase()
            );

            let pular = false;
            const idsRemover = [];
            for (const r of conflitos) {
                const df = converterParaDate(r.fim_autorizacao);
                if (df && novaDataFim && novaDataFim <= df) { pular = true; break; }
                else idsRemover.push(r.id);
            }

            if (pular) { ignorados++; continue; }
            if (idsRemover.length > 0) {
                await supabase.from('autorizacoes').delete().in('id', idsRemover);
                idsRemover.forEach(id => {
                    const idx = todosAtuais.findIndex(x => x.id === id);
                    if (idx !== -1) todosAtuais.splice(idx, 1);
                });
            }

            const { data: ins } = await supabase.from('autorizacoes').insert([novoReg]).select();
            if (ins) { todosAtuais.push(ins[0]); importados++; }
        }
        res.status(201).json({ mensagem: `Processamento concluído!\n• ${importados} atualizados.\n• ${ignorados} ignorados (data menor).` });
    } catch (err) {
        res.status(500).json({ erro: 'Falha no processamento.', detalhe: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Sistema operando na porta ${PORT}`); });