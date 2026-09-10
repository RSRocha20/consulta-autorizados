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

// SENHA DO ADMINISTRADOR
const SENHA_ADMIN = 'bgkfrcamara26';

app.post('/verificar-admin', (req, res) => {
    const { senha } = req.body;
    if (senha === SENHA_ADMIN) {
        res.json({ sucesso: true });
    } else {
        res.json({ sucesso: false });
    }
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

// Converte string DD/MM/AAAA para objeto Date para fins de comparação
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
            if (p.length === 3) partes = [p[2], p[1], p[0]];
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

// Cadastro Manual com Regra de Data Fim Mais Longa
app.post('/autorizacoes', async (req, res) => {
    const nova = req.body;
    nova.nome = formatarNome(nova.nome); 
    nova.data_mensagem = formatarDataParaExibicao(nova.data_mensagem);
    nova.inicio_autorizacao = formatarDataParaExibicao(nova.inicio_autorizacao);
    nova.fim_autorizacao = formatarDataParaExibicao(nova.fim_autorizacao);
    
    // Busca registros existentes para a mesma pessoa, empresa e local
    let query = supabase.from('autorizacoes').select('*').ilike('nome', nova.nome);
    if (nova.empresa) query = query.ilike('empresa', nova.empresa);
    if (nova.local_autorizacao) query = query.ilike('local_autorizacao', nova.local_autorizacao);

    const { data: existentes, error: errBusca } = await query;
    if (errBusca) return res.status(500).json({ erro: errBusca.message });

    const novaDataFim = converterParaDate(nova.fim_autorizacao);

    if (existentes && existentes.length > 0) {
        let deveInserir = true;

        for (const regExistente of existentes) {
            const dataFimExistente = converterParaDate(regExistente.fim_autorizacao);

            // Se o registro existente tem data fim e a nova data fim é menor ou igual, impede a inserção
            if (dataFimExistente && novaDataFim && novaDataFim <= dataFimExistente) {
                deveInserir = false;
                break;
            }
        }

        if (!deveInserir) {
            return res.status(400).json({ erro: 'Registro não inserido: já existe um cadastro ativo com data fim igual ou mais longa para este nome, empresa e local.' });
        }

        // Se a nova data fim for maior, remove os antigos mais curtos e insere o novo
        const idsAntigos = existentes.map(r => r.id);
        await supabase.from('autorizacoes').delete().in('id', idsAntigos);
    }

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

// Importação com Regra de Data Fim Mais Longa
app.post('/importar', upload.single('planilha'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não localizado.' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const dadosPlanilha = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { raw: true });

        if (dadosPlanilha.length === 0) return res.status(400).json({ erro: 'Planilha vazia.' });

        // Busca todos os registros atuais do banco para checagem rápida
        const { data: todosAtuais, error: errBanco } = await supabase.from('autorizacoes').select('*');
        if (errBanco) return res.status(500).json({ erro: errBanco.message });

        let importados = 0;
        let ignoradosPorData = 0;

        for (const linha of dadosPlanilha) {
            const linhaNormalizada = {};
            for (let chave in linha) {
                let chaveLimpa = chave.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
                linhaNormalizada[chaveLimpa] = linha[chave];
            }

            const nomeBruto = linhaNormalizada['NOME'];
            if (!nomeBruto) continue;

            const nomeFormatado = formatarNome(nomeBruto); 
            let valorDataRaw = linhaNormalizada['DATA DA MENSAGEM'] || linhaNormalizada['DATA MENSAGEM'] || linhaNormalizada['DATA'];
            
            const novoReg = {
                data_mensagem: formatarDataParaExibicao(valorDataRaw),
                nome: nomeFormatado,
                inicio_autorizacao: formatarDataParaExibicao(linhaNormalizada['INÍCIO'] || linhaNormalizada['INICIO']),
                fim_autorizacao: formatarDataParaExibicao(linhaNormalizada['FIM']),
                empresa: linhaNormalizada['EMPRESA'] ? String(linhaNormalizada['EMPRESA']).trim() : '',
                local_autorizacao: linhaNormalizada['LOCAL'] ? String(linhaNormalizada['LOCAL']).trim() : '',
                formato_envio: linhaNormalizada['FORMATO'] || linhaNormalizada['FORMATO ENVIO'] || 'Mensagem'
            };

            const novaDataFim = converterParaDate(novoReg.fim_autorizacao);

            // Verifica se já existe no banco com a mesma chave (Nome + Empresa + Local)
            const conflitos = todosAtuais.filter(r => 
                r.nome.toLowerCase() === novoReg.nome.toLowerCase() &&
                (r.empresa || '').toLowerCase() === (novoReg.empresa || '').toLowerCase() &&
                (r.local_autorizacao || '').toLowerCase() === (novoReg.local_autorizacao || '').toLowerCase()
            );

            let pularInsercao = false;
            const idsParaRemover = [];

            if (conflitos.length > 0) {
                for (const regExistente of conflitos) {
                    const dataFimExistente = converterParaDate(regExistente.fim_autorizacao);

                    if (dataFimExistente && novaDataFim && novaDataFim <= dataFimExistente) {
                        pularInsercao = true;
                        break;
                    } else {
                        idsParaRemover.push(regExistente.id);
                    }
                }
            }

            if (pularInsercao) {
                ignoradosPorData++;
                continue;
            }

            // Se vai substituir, remove os registros mais antigos com data menor
            if (idsParaRemover.length > 0) {
                await supabase.from('autorizacoes').delete().in('id', idsParaRemover);
                // Atualiza a lista local de 'todosAtuais' para evitar duplicatas em lote na mesma importação
                idsParaRemover.forEach(idRemovido => {
                    const idx = todosAtuais.findIndex(x => x.id === idRemovido);
                    if (idx !== -1) todosAtuais.splice(idx, 1);
                });
            }

            const { data: inserido, error: errIns } = await supabase.from('autorizacoes').insert([novoReg]).select();
            if (!errIns && inserido) {
                todosAtuais.push(inserido[0]);
                importados++;
            }
        }

        res.status(201).json({ 
            mensagem: `Processamento concluído!\n• ${importados} registros novos/atualizados.\n• ${ignoradosPorData} ignorados (já possuíam data fim mais longa).` 
        });
    } catch (err) {
        console.error("Erro importação:", err);
        res.status(500).json({ erro: 'Falha durante o processamento.', detalhe: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Sistema operando na porta ${PORT}`);
});