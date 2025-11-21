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
            
            // ★ 修改：如果是 admin，不受长度限制；其他账号必须 >= 8位
            if (username !== 'admin' && (!username || username.length < 8)) {
                return res.status(400).json({ error: '账号需≥8位' });
            }
            if (!password || password.length < 6) return res.status(400).json({ error: '密码需≥6位' });
            if (!nickname) return res.status(400).json({ error: '请输入昵称' });

            const userRef = db.collection('cp_users').doc(username);
            if ((await userRef.get()).exists) return res.status(400).json({ error: '账号已存在' });

            const u = { username, password: hashPassword(password), nickname, avatar: avatar||'', isAdmin: username==='admin', createdAt: new Date() };
            await userRef.set(u);
            delete u.password;
            return res.json({ success: true, user: u });
        }

        if (action === 'login') {
            const { username, password } = body;
            const userRef = db.collection('cp_users').doc(username);
            const userDoc = await userRef.get();
            
            if (!userDoc.exists) return res.status(400).json({ error: '账号不存在' });
            
            const data = userDoc.data();
            const now = Date.now();

            // ★ 1. 检查是否被锁定
            if (data.lockoutUntil && data.lockoutUntil.toMillis() > now) {
                const waitMin = Math.ceil((data.lockoutUntil.toMillis() - now) / 60000);
                return res.status(403).json({ error: `账号已锁定，请 ${waitMin} 分钟后再试` });
            }

            // ★ 2. 验证密码
            if (data.password !== hashPassword(password)) {
                // 计算失败次数
                let failedAttempts = data.failedAttempts || 0;
                const lastFailedAt = data.lastFailedAt ? data.lastFailedAt.toMillis() : 0;

                // 如果距离上次失败超过30分钟，重置计数
                if (now - lastFailedAt > 30 * 60 * 1000) {
                    failedAttempts = 0;
                }

                failedAttempts++;
                const updates = { failedAttempts, lastFailedAt: admin.firestore.Timestamp.fromMillis(now) };

                // 如果失败满3次，锁定30分钟
                if (failedAttempts >= 3) {
                    updates.lockoutUntil = admin.firestore.Timestamp.fromMillis(now + 30 * 60 * 1000);
                    await userRef.update(updates);
                    return res.status(403).json({ error: '密码错误次数过多，账号已锁定30分钟' });
                } else {
                    await userRef.update(updates);
                    return res.status(400).json({ error: `密码错误 (剩余机会: ${3 - failedAttempts}次)` });
                }
            }
            
            // ★ 3. 登录成功，重置计数
            if (data.failedAttempts > 0 || data.lockoutUntil) {
                await userRef.update({ failedAttempts: 0, lockoutUntil: null, lastFailedAt: null });
            }

            data.isAdmin = (data.username === 'admin');
            delete data.password;
            delete data.failedAttempts;
            delete data.lockoutUntil;
            delete data.lastFailedAt;
            
            return res.json({ success: true, user: data });
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
            await db.collection('cp_posts').add({
                nickname: body.user.nickname, username: body.user.username, avatar: body.user.avatar,
                game: body.game, desc: body.content, requirement: body.requirement, images: body.images,
                likes: 0, likedIds: [], commentsCount: 0, timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_post') {
            if (!body.user) return res.status(401).json({ error: '请登录' });
            const docRef = db.collection('cp_posts').doc(body.id);
            const doc = await docRef.get();
            if (!doc.exists) return res.status(404).json({ error: '帖子不存在' });
            
            const data = doc.data();
            if (body.user.username !== 'admin' && body.user.username !== data.username) {
                return res.status(403).json({ error: '无权操作' });
            }
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

        // 评论
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
            if (!body.user) return res.status(401).json({ error: '请登录' });
            const postRef = db.collection('cp_posts').doc(body.postId);
            const commentRef = postRef.collection('comments').doc(body.commentId);
            const commentDoc = await commentRef.get();
            
            if (!commentDoc.exists) return res.status(404).json({ error: '评论不存在' });
            const cmtData = commentDoc.data();

            if (body.user.username !== 'admin' && body.user.username !== cmtData.username) {
                return res.status(403).json({ error: '无权操作' });
            }

            await db.runTransaction(async t => {
                t.delete(commentRef);
                t.update(postRef, { commentsCount: admin.firestore.FieldValue.increment(-1) });
            });
            return res.json({ success: true });
        }

        return res.status(404).json({ error: 'API not found' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
}
