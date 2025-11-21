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

// 获取用户唯一标识 (IP 或 用户名)
const getIdentifier = (req, userBody) => {
    if (userBody && userBody.username) return `user:${userBody.username}`;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    return `ip:${ip.split(',')[0].trim()}`;
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
            
            if (!username || username.length < 8) return res.status(400).json({ error: '账号至少要8位哦' });
            if (!password || password.length < 6) return res.status(400).json({ error: '密码至少设置6位' });
            if (!nickname) return res.status(400).json({ error: '昵称不能为空' });

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
            if (userData.password !== hashPassword(password)) {
                return res.status(400).json({ error: '密码错误' });
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
                // 转换时间
                let timeStr = "刚刚";
                if (data.timestamp && data.timestamp._seconds) {
                    const date = new Date(data.timestamp._seconds * 1000);
                    // 简单的日期格式化
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
                    // 返回 likedIds 供前端判断 (注意数据量)
                    likedIds: data.likedIds || [] 
                });
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
                likedIds: [], 
                commentsCount: 0,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            return res.json({ success: true });
        }

        if (req.method === 'POST' && action === 'delete_post') {
            const { id, user } = body;
            if (!user || user.username !== 'admin') {
                return res.status(403).json({ error: '权限不足' });
            }
            await db.collection('cp_posts').doc(id).delete();
            return res.json({ success: true });
        }

        // ==========================================
        // 3. 互动模块
        // ==========================================

        // ★ 核心修复：严格的 Toggle 逻辑
        if (req.method === 'POST' && action === 'like') {
            const { id, user } = body;
            const docRef = db.collection('cp_posts').doc(id);
            const identifier = getIdentifier(req, user);

            await db.runTransaction(async (t) => {
                const doc = await t.get(docRef);
                if (!doc.exists) throw "Post not found";

                const data = doc.data();
                const likedIds = data.likedIds || [];
                const index = likedIds.indexOf(identifier);

                let newLikes = data.likes || 0;

                if (index > -1) {
                    // 已点赞 -> 取消
                    likedIds.splice(index, 1);
                    newLikes = Math.max(0, newLikes - 1);
                } else {
                    // 未点赞 -> 添加
                    // 防止数组无限膨胀，保留最近 2000 个赞的人
                    if (likedIds.length > 2000) likedIds.shift(); 
                    likedIds.push(identifier);
                    newLikes = newLikes + 1;
                }

                t.update(docRef, {
                    likedIds: likedIds,
                    likes: newLikes
                });
            });
            
            return res.json({ success: true, identifier });
        }

        // 获取评论
        if (req.method === 'GET' && action === 'get_comments') {
            const { postId } = req.query;
            const snapshot = await db.collection('cp_posts').doc(postId).collection('comments')
                .orderBy('timestamp', 'asc')
                .get();
            const comments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return res.json(comments);
        }

        // 发送评论
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

        // 删除评论
        if (req.method === 'POST' && action === 'delete_comment') {
            const { postId, commentId, user } = body;
            if (!user || user.username !== 'admin') {
                return res.status(403).json({ error: '权限不足' });
            }

            const postRef = db.collection('cp_posts').doc(postId);
            const commentRef = postRef.collection('comments').doc(commentId);

            await db.runTransaction(async (t) => {
                t.delete(commentRef);
                t.update(postRef, {
                    commentsCount: admin.firestore.FieldValue.increment(-1)
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
