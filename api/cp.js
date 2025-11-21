import admin from 'firebase-admin';

// --- 初始化逻辑 (复用你原有的) ---
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

export default async function handler(req, res) {
    // CORS 设置
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const collection = db.collection('cp_posts');

        // --- GET: 获取扩列列表 ---
        if (req.method === 'GET') {
            const snapshot = await collection
                .orderBy('timestamp', 'desc')
                .limit(50)
                .get();
            
            const posts = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                // 转换时间戳
                let timeStr = "刚刚";
                if (data.timestamp && data.timestamp._seconds) {
                    const date = new Date(data.timestamp._seconds * 1000);
                    const now = new Date();
                    // 简单的显示逻辑
                    if (now - date < 86400000) {
                        timeStr = date.toLocaleTimeString('zh-CN', {hour: '2-digit', minute:'2-digit'});
                    } else {
                        timeStr = date.toLocaleDateString('zh-CN', {month: '2-digit', day:'2-digit'});
                    }
                }

                posts.push({
                    id: doc.id,
                    ...data,
                    timeStr
                });
            });
            
            res.status(200).json(posts);
        } 
        // --- POST: 发布新扩列 ---
        else if (req.method === 'POST') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { nickname, gender, game, desc, requirement, imageBase64 } = body;

            // 简单校验
            if (!nickname || !desc) {
                return res.status(400).json({ error: '昵称和介绍不能为空' });
            }

            // 存入 Firestore
            // 注意：imageBase64 必须在前端压缩过，否则可能超过 Firestore 1MB 限制
            await collection.add({
                nickname: nickname.slice(0, 20),
                gender,
                game,
                desc: desc.slice(0, 200),
                requirement: requirement ? requirement.slice(0, 200) : '',
                imageBase64: imageBase64 || '', // 存储 Base64 图片字符串
                likes: 0,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            res.status(200).json({ success: true });
        }
        // --- PUT: 点赞 ---
        else if (req.method === 'PUT') {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { id } = body;
            
            if (!id) return res.status(400).json({ error: 'ID is required' });

            const docRef = collection.doc(id);
            await docRef.update({
                likes: admin.firestore.FieldValue.increment(1)
            });

            res.status(200).json({ success: true });
        }
        else {
            res.status(405).json({ error: 'Method not allowed' });
        }
    } catch (error) {
        console.error("API Error:", error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}
