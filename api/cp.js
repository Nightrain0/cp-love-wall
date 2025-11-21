import admin from 'firebase-admin';

// 防止冷启动多次初始化 & 环境变量检查
if (!admin.apps.length) {
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } catch (e) {
            console.error("❌ Firebase Init Error:", e);
        }
    } else {
        console.error("❌ Missing FIREBASE_CREDENTIALS");
    }
}

const getDb = () => {
    try { return admin.firestore(); } catch (e) { return null; }
};

const hashPassword = (pwd) => Buffer.from(pwd + "cpdd_salt").toString('base64');
const getIdentifier = (req, body) => body?.username ? 'user:'+body.username : 'ip:'+(req.headers['x-forwarded-for']||'unknown').split(',')[0];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const db = getDb();
    if (!db) return res.status(500).json({ error: '数据库连接失败' });

    try {
        const { action } = req.query;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

        // --- 鉴权 ---
        if (action === 'register') {
            const { username, password, nickname, avatar } = body;
            if (!username || (username !== 'admin' && username.length < 8)) return res.status(400).json({ error: '账号需≥8位' });
            if (!password || password.length < 6) return res.status(400).json({ error: '密码需≥6位' });
            if (!nickname) return res.status(400).json({ error: '请输入昵称' });

            const userRef = db.collection('cp_users').doc(username);
            if ((await userRef.get()).exists) return res.status(400).json({ error: '账号已存在' });

            // 初始资料
            const u = { 
                username, password: hashPassword(password), nickname, avatar: avatar||'', 
                isAdmin: username==='admin', 
                gender: 'secret', target: 'all', qq: '', wx: '', // 默认值
                createdAt: new Date() 
            };
            await userRef.set(u);
            delete u.password;
            return res.json({ success: true, user: u });
        }

        if (action === 'login') {
            const doc = await db.collection('cp_users').doc(body.username).get();
            if (!doc.exists) return res.status(400).json({ error: '账号不存在' });
            
            const u = doc.data();
            // 锁定逻辑
            const now = Date.now();
            if (u.lockUntil && u.lockUntil.toMillis() > now) return res.status(403).json({ error: '账号已锁定，请稍后再试' });

            if (u.password !== hashPassword(body.password)) {
                let fails = (u.fails || 0) + 1;
                let updates = { fails };
                if (fails >= 3) updates.lockUntil = admin.firestore.Timestamp.fromMillis(now + 30*60*1000); // 锁30分钟
                await db.collection('cp_users').doc(body.username).update(updates);
                return res.status(400).json({ error: `密码错误 (剩余${3-fails}次)` });
            }
            
            // 登录成功清空失败记录
            if(u.fails) await db.collection('cp_users').doc(body.username).update({ fails: 0, lockUntil: null });

            u.isAdmin = (u.username === 'admin');
            delete u.password;
            return res.json({ success: true, user: u });
        }

        // ★ 新增：更新个人资料
        if (req.method === 'POST' && action === 'update_profile') {
            if (!body.user) return res.status(401).json({ error: '请登录' });
            // 简单的身份校验：只能改自己的
            if (body.user.username !== body.username) return res.status(403).json({ error: '非法操作' });

            const updates = {
                nickname: body.nickname,
                avatar: body.avatar,
                gender: body.gender || 'secret',
                target: body.target || 'all',
                qq: body.qq || '',
                wx: body.wx || ''
            };

            await db.collection('cp_users').doc(body.username).update(updates);
            
            // 返回最新资料
            const newDoc = await db.collection('cp_users').doc(body.username).get();
            const u = newDoc.data();
            delete u.password;
            return res.json({ success: true, user: u });
        }

        // --- 帖子 ---
        if (req.method === 'GET' && !action) {
            try {
                const snap = await db.collection('cp_posts').orderBy('timestamp', 'desc').limit(60).get();
                const posts = [];
                snap.forEach(d => {
                    const data = d.data();
                    let timeStr = "刚刚";
                    if(data.timestamp && data.timestamp._seconds) {
                        const dt = new Date(data.timestamp._seconds * 1000);
                        timeStr = `${dt.getMonth()+1}-${dt.getDate()} ${dt.getHours()}:${String(dt.getMinutes()).padStart(2,'0')}`;
                    }
                    posts.push({ id: d.id, ...data, timeStr, likedIds: data.likedIds||[] });
                });
                return res.json(posts);
            } catch(e) { return res.status(500).json({ error: '加载失败' }); }
        }

        if (req.method === 'POST' && action === 'create_post') {
            if (!body.user) return res.status(401).json({ error: '请登录' });
            
            // ★ 发帖时带上用户当前的资料快照
            await db.collection('cp_posts').add({
                nickname: body.user.nickname, 
                username: body.user.username, 
                avatar: body.user.avatar,
                // 存入个人资料字段
                gender: body.user.gender || 'secret',
                target: body.user.target || 'all',
                qq: body.user.qq || '',
                wx: body.user.wx || '',
                
                game: body.game, 
                desc: body.content, 
                requirement: body.requirement, 
                images: body.images,
                likes: 0, 
                likedIds: [], 
                commentsCount: 0, 
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_post') {
            if (!body.user) return res.status(401).json({ error: '请登录' });
            const docRef = db.collection('cp_posts').doc(body.id);
            const doc = await docRef.get();
            if(!doc.exists) return res.json({success:true}); 
            if (body.user.username !== 'admin' && body.user.username !== doc.data().username) return res.status(403).json({ error: '无权操作' });
            await docRef.delete();
            return res.json({ success: true });
        }

        // 点赞
        if (req.method === 'POST' && action === 'like') {
            const ref = db.collection('cp_posts').doc(body.id);
            const uid = getIdentifier(req, body.user);
            await db.runTransaction(async t => {
                const doc = await t.get(ref);
                if (!doc.exists) return;
                const d = doc.data();
                const ids = d.likedIds || [];
                const idx = ids.indexOf(uid);
                if (idx > -1) {
                    ids.splice(idx, 1);
                    t.update(ref, { likedIds: ids, likes: Math.max(0, (d.likes||0)-1) });
                } else {
                    if(ids.length > 2000) ids.shift();
                    ids.push(uid);
                    t.update(ref, { likedIds: ids, likes: (d.likes||0)+1 });
                }
            });
            return res.json({ success: true });
        }

        // 评论模块 (略微简化，逻辑不变)
        if (req.method === 'GET' && action === 'get_comments') {
            const snap = await db.collection('cp_posts').doc(req.query.postId).collection('comments').orderBy('timestamp', 'asc').get();
            return res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        }
        if (req.method === 'POST' && action === 'add_comment') {
            const ref = db.collection('cp_posts').doc(body.postId);
            await db.runTransaction(async t => {
                t.set(ref.collection('comments').doc(), {
                    nickname: body.user.nickname, username: body.user.username, avatar: body.user.avatar,
                    content: body.content, timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                t.update(ref, { commentsCount: admin.firestore.FieldValue.increment(1) });
            });
            return res.json({ success: true });
        }
        if (req.method === 'POST' && action === 'delete_comment') {
            const ref = db.collection('cp_posts').doc(body.postId);
            const cmtRef = ref.collection('comments').doc(body.commentId);
            const cmt = await cmtRef.get();
            if(cmt.exists && (body.user.username==='admin' || body.user.username===cmt.data().username)) {
                await cmtRef.delete();
                await ref.update({ commentsCount: admin.firestore.FieldValue.increment(-1) });
            }
            return res.json({ success: true });
        }

        return res.status(404).json({ error: 'API not found' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
}
