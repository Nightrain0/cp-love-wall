import admin from 'firebase-admin';

// --- 初始化逻辑 ---
if (!admin.apps.length) {
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } catch (e) {
            console.error("❌ 私钥解析失败", e);
        }
    } else {
        console.error("❌ 未找到 FIREBASE_CREDENTIALS 环境变量");
    }
}

const db = admin.firestore();

// 简单的密码哈希
const hashPassword = (pwd) => {
    return Buffer.from(pwd + "cpdd_salt").toString('base64');
};

export default async function handler(req, res) {
    // CORS 设置
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const { action } = req.query;
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};

        // ==========================================
        // 1. 鉴权模块 (注册/登录)
        // ==========================================
        
        if (action === 'register') {
            const { username, password, nickname, avatar } = body;
            
            // ★ 新增：长度校验
            if (!username || username.length < 3) {
                return res.status(400).json({ error: '账号有点短，至少要3个字符哦' });
            }
            if (!password || password.length < 6) {
                return res.status(400).json({ error: '密码太简单啦，至少设置6位吧' });
            }
            if (!nickname) {
                return res.status(400).json({ error: '取个好听的名字吧' });
            }

            const userRef = db.collection('cp_users').doc(username);
            const userDoc = await userRef.get();
            if (userDoc.exists) return res.status(400).json({ error: '这个账号名已经被别人抢先啦' });

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
            
            if (!userDoc.exists) return res.status(400).json({ error: '账号不存在，要不先注册一个？' });
            
            const userData = userDoc.data();
            if (userData.password !== hashPassword(password)) {
                return res.status(400).json({ error: '密码不对哦，再想想' });
            }

            userData.isAdmin = (userData.username === 'admin');
            
            delete userData.password;
            return res.json({ success: true, user: userData });
        }

        // ==========================================
        // 2. 帖子模块
        // ==========================================

        if (req.method === 'GET' && !action) {
            const snapshot = await db.collection('cp_posts')
                .orderBy('timestamp', 'desc')
                .limit(50)
                .get();
            
            const posts = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                let timeStr = "刚刚";
                if (data.timestamp && data.timestamp._seconds) {
                    const date = new Date(data.timestamp._seconds * 1000);
                    const now = new Date();
                    if (now - date < 86400000) {
                        timeStr = date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'});
                    } else {
                        timeStr = date.toLocaleDateString('zh-CN', {month: '2-digit', day:'2-digit'});
                    }
                }
                posts.push({ id: doc.id, ...data, timeStr });
            });
            return res.json(posts);
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
                commentsCount: 0,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ success: true });
        }

        // 管理员删除帖子
        if (req.method === 'POST' && action === 'delete_post') {
            const { id, user } = body;
            if (!user || user.username !== 'admin') {
                return res.status(403).json({ error: '权限不足，只有管理员(admin)可以删除' });
            }
            await db.collection('cp_posts').doc(id).delete();
            return res.json({ success: true });
        }

        // ==========================================
        // 3. 互动模块
        // ==========================================

        if (req.method === 'POST' && action === 'like') {
            const { id } = body;
            await db.collection('cp_posts').doc(id).update({
                likes: admin.firestore.FieldValue.increment(1)
            });
            return res.json({ success: true });
        }

        if (req.method === 'GET' && action === 'get_comments') {
            const { postId } = req.query;
            if (!postId) return res.status(400).json({ error: 'Missing postId' });

            const snapshot = await db.collection('cp_posts').doc(postId).collection('comments')
                .orderBy('timestamp', 'asc')
                .get();
            
            const comments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return res.json(comments);
        }

        if (req.method === 'POST' && action === 'add_comment') {
            const { postId, user, content } = body;
            if (!user) return res.status(401).json({ error: '请先登录' });

            const postRef = db.collection('cp_posts').doc(postId);
            await db.runTransaction(async (t) => {
                const commentRef = postRef.collection('comments').doc();
                t.set(commentRef, {
                    nickname: user.nickname,
                    username: user.username,
                    avatar: user.avatar,
                    content: content,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
                t.update(postRef, {
                    commentsCount: admin.firestore.FieldValue.increment(1)
                });
            });
            return res.json({ success: true });
        }

        return res.status(404).json({ error: 'API action not found' });

    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}
