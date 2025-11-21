import admin from 'firebase-admin';

// --- 初始化逻辑 ---
// 增加全局变量防止冷启动多次初始化
if (!admin.apps.length) {
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("Firebase initialized successfully.");
        } catch (e) {
            console.error("❌ Firebase init failed:", e);
        }
    } else {
        console.error("❌ Missing FIREBASE_CREDENTIALS env var.");
    }
}

// 安全获取 Firestore 实例
const getDb = () => {
    try {
        return admin.firestore();
    } catch (e) {
        console.error("Firestore access failed:", e);
        return null;
    }
};

const hashPassword = (pwd) => {
    return Buffer.from(pwd + "cpdd_salt").toString('base64');
};

const getIdentifier = (req, userBody) => {
    if (userBody && userBody.username) return `user:${userBody.username}`;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    return `ip:${ip.split(',')[0].trim()}`;
};

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const db = getDb();
    if (!db) {
        return res.status(500).json({ error: 'Service Unavailable: Database connection failed.' });
    }

    try {
        const { action } = req.query;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

        // --- 鉴权 ---
        if (action === 'register') {
            const { username, password, nickname, avatar } = body;
            if (!username || username.length < 8) return res.status(400).json({ error: '账号太短，至少8位' });
            if (!password || password.length < 6) return res.status(400).json({ error: '密码太短，至少6位' });
            if (!nickname) return res.status(400).json({ error: '请输入昵称' });

            const userRef = db.collection('cp_users').doc(username);
            const userDoc = await userRef.get();
            if (userDoc.exists) return res.status(400).json({ error: '账号已存在' });

            const userData = {
                username,
                password: hashPassword(password),
                nickname,
                avatar: avatar || '', 
                isAdmin: username === 'admin', 
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            await userRef.set(userData);
            delete userData.password;
            return res.json({ success: true, user: userData });
        }

        if (action === 'login') {
            const { username, password } = body;
            const userRef = db.collection('cp_users').doc(username);
            const userDoc = await userRef.get();
            if (!userDoc.exists) return res.status(400).json({ error: '账号不存在' });
            
            const userData = userDoc.data();
            if (userData.password !== hashPassword(password)) return res.status(400).json({ error: '密码错误' });
            
            userData.isAdmin = (userData.username === 'admin');
            delete userData.password;
            return res.json({ success: true, user: userData });
        }

        // --- 帖子 ---
        if (req.method === 'GET' && !action) {
            try {
                const snapshot = await db.collection('cp_posts')
                    .orderBy('timestamp', 'desc')
                    .limit(60) // 增加一点数量
                    .get();
                
                const posts = [];
                snapshot.forEach(doc => {
                    const data = doc.data();
                    let timeStr = "刚刚";
                    if (data.timestamp && data.timestamp._seconds) {
                        const date = new Date(data.timestamp._seconds * 1000);
                        const now = new Date();
                        if (now.toDateString() === date.toDateString()) {
                            timeStr = date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'});
                        } else {
                            timeStr = date.toLocaleDateString('zh-CN', {month: '2-digit', day:'2-digit'});
                        }
                    }
                    posts.push({ 
                        id: doc.id, 
                        ...data, 
                        timeStr,
                        likedIds: data.likedIds || [] 
                    });
                });
                return res.json(posts);
            } catch (err) {
                console.error("Query error:", err);
                return res.status(500).json({ error: 'Failed to load posts' });
            }
        }

        if (req.method === 'POST' && action === 'create_post') {
            const { user, content, game, images, requirement } = body;
            if (!user || !user.username) return res.status(401).json({ error: '请先登录' });
            if (!content) return res.status(400).json({ error: '内容不能为空' });

            await db.collection('cp_posts').add({
                nickname: user.nickname,
                username: user.username,
                avatar: user.avatar || '',
                game: game || '其他',
                desc: content.slice(0, 800),
                requirement: requirement || '',
                images: images || [], 
                likes: 0,
                likedIds: [], 
                commentsCount: 0,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_post') {
            const { id, user } = body;
            if (!user || user.username !== 'admin') return res.status(403).json({ error: '权限不足' });
            await db.collection('cp_posts').doc(id).delete();
            return res.json({ success: true });
        }

        // --- 互动 (修复点赞) ---
        if (req.method === 'POST' && action === 'like') {
            const { id, user } = body;
            const docRef = db.collection('cp_posts').doc(id);
            const identifier = getIdentifier(req, user);

            await db.runTransaction(async (t) => {
                const doc = await t.get(docRef);
                if (!doc.exists) throw "Post missing";

                const data = doc.data();
                const likedIds = data.likedIds || [];
                const index = likedIds.indexOf(identifier);
                let newLikes = data.likes || 0;

                if (index > -1) {
                    // 取消赞
                    likedIds.splice(index, 1);
                    newLikes = Math.max(0, newLikes - 1);
                } else {
                    // 点赞
                    if (likedIds.length > 3000) likedIds.shift(); // 扩容
                    likedIds.push(identifier);
                    newLikes = newLikes + 1;
                }

                t.update(docRef, { likedIds: likedIds, likes: newLikes });
            });
            return res.json({ success: true, identifier });
        }

        // 评论相关
        if (req.method === 'GET' && action === 'get_comments') {
            const { postId } = req.query;
            const snapshot = await db.collection('cp_posts').doc(postId).collection('comments').orderBy('timestamp', 'asc').get();
            return res.json(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        }

        if (req.method === 'POST' && action === 'add_comment') {
            const { postId, user, content } = body;
            if (!user) return res.status(401).json({ error: '请登录' });
            const postRef = db.collection('cp_posts').doc(postId);
            await db.runTransaction(async (t) => {
                t.set(postRef.collection('comments').doc(), {
                    nickname: user.nickname,
                    username: user.username,
                    avatar: user.avatar,
                    content,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                t.update(postRef, { commentsCount: admin.firestore.FieldValue.increment(1) });
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_comment') {
            const { postId, commentId, user } = body;
            if (!user || user.username !== 'admin') return res.status(403).json({ error: '权限不足' });
            const postRef = db.collection('cp_posts').doc(postId);
            await db.runTransaction(async (t) => {
                t.delete(postRef.collection('comments').doc(commentId));
                t.update(postRef, { commentsCount: admin.firestore.FieldValue.increment(-1) });
            });
            return res.json({ success: true });
        }

        return res.status(404).json({ error: 'API not found' });
    } catch (e) {
        console.error("API Error:", e);
        res.status(500).json({ error: e.message });
    }
}
