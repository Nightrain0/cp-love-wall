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
    // 取 x-forwarded-for 的第一个 IP (真实 IP)
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
        // 1. 鉴权模块
        // ==========================================
        
        if (action === 'register') {
            const { username, password, nickname, avatar } = body;
            
            // ★ 修改：账号至少8位
            if (!username || username.length < 8) {
                return res.status(400).json({ error: '账号太短啦，至少要8位字符哦' });
            }
            if (!password || password.length < 6) {
                return res.status(400).json({ error: '密码太简单啦，至少设置6位吧' });
            }
            if (!nickname) return res.status(400).json({ error: '取个好听的名字吧' });

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
                return res.status(400).json({ error: '密码不对哦' });
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
            
            // 获取当前请求者的 ID，用于判断是否点赞过
            // 注意：GET 请求没有 body，难以获取 user，这里主要靠 IP 判断
            // 或者前端获取后自己对比 likedIds
            const posts = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                // 转换时间
                let timeStr = "刚刚";
                if (data.timestamp && data.timestamp._seconds) {
                    const date = new Date(data.timestamp._seconds * 1000);
                    timeStr = date.toLocaleDateString('zh-CN', {month: '2-digit', day:'2-digit'}) + " " + date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'});
                }
                
                // 为了节省带宽，likedIds 数组不一定非要全返回，但为了判断状态，先返回
                // 如果数组太大，可以考虑只返回 count
                posts.push({ 
                    id: doc.id, 
                    ...data, 
                    timeStr,
                    likedIds: data.likedIds || [] // 确保有这个字段
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
                likedIds: [], // ★ 新增：存储点赞人的 ID 数组
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
        // 3. 互动模块 (点赞/评论)
        // ==========================================

        // ★ 重构：点赞/取消点赞 (Toggle)
        if (req.method === 'POST' && action === 'like') {
            const { id, user } = body;
            const docRef = db.collection('cp_posts').doc(id);
            const identifier = getIdentifier(req, user); // 获取 IP 或 用户名

            await db.runTransaction(async (t) => {
                const doc = await t.get(docRef);
                if (!doc.exists) throw "Post not found";

                const data = doc.data();
                const likedIds = data.likedIds || [];
                const index = likedIds.indexOf(identifier);

                if (index > -1) {
                    // 已点赞 -> 取消
                    likedIds.splice(index, 1);
                    t.update(docRef, {
                        likedIds: likedIds,
                        likes: Math.max(0, (data.likes || 1) - 1)
                    });
                } else {
                    // 未点赞 -> 添加
                    // 限制数组长度，防止文档过大 (比如只存最近500个，或者不限制看情况)
                    if (likedIds.length > 1000) likedIds.shift(); 
                    likedIds.push(identifier);
                    t.update(docRef, {
                        likedIds: likedIds,
                        likes: (data.likes || 0) + 1
                    });
                }
            });
            return res.json({ success: true, identifier }); // 返回 ID 供前端调试
        }

        if (req.method === 'GET' && action === 'get_comments') {
            const { postId } = req.query;
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

        // ★ 新增：管理员删除评论
        if (req.method === 'POST' && action === 'delete_comment') {
            const { postId, commentId, user } = body;
            if (!user || user.username !== 'admin') {
                return res.status(403).json({ error: '权限不足' });
            }

            const postRef = db.collection('cp_posts').doc(postId);
            const commentRef = postRef.collection('comments').doc(commentId);

            await db.runTransaction(async (t) => {
                t.delete(commentRef);
                // 评论数 -1
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
