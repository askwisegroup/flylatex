import { useEffect, useState } from "react";
import AccessibleModal from "@/shared/components/accessible-modal";
import { Button, Modal } from "react-bootstrap";

import './AIChat.css'; // 引入样式

export interface AIChatProps {
    show: boolean;
    onHide?: () => void;
}

interface HistoryItem {
    question: string;
    answer: string;
}

// load chat history from localStorage
const loadHistory = (): HistoryItem[] => {
    const history = localStorage.getItem('chatHistory');
    return history ? JSON.parse(history) : [];
};

// save chat history to localStorage
const saveHistory = (history: HistoryItem[]) => {
    // 如果history超过10条，仅保留最后10条记录
    if (history.length > 10) {
        history = history.slice(history.length - 10);
    }
    localStorage.setItem('chatHistory', JSON.stringify(history));
};

export const AIChat = (props: AIChatProps) => {
    const [question, setQuestion] = useState('');
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [dlgShow, setDlgShow] = useState(props.show);
    const [isProcessing, setIsProcessing] = useState(false);

    const handleSubmit = (e: any) => {
        e.preventDefault();
        let q = question.trim();
        if (!q) return; // 防止提交空问题
        // 假设getAnswer是一个函数，用于获取问题的答案，这里我们直接将问题添加到历史记录中
        // 实际应用中，你可能需要调用API获取答案
        setIsProcessing(true);
        fetch('../ai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: q,
                mode: 'chat'
            })
        }).then(res => res.json()).then(data => {
            let _data = data.data;
            const newHistory = [...history, { question, answer: _data }];
            setHistory(newHistory);
            setQuestion(''); // 清空输入框
            saveHistory(newHistory);
            setIsProcessing(false);
        });

    };

    useEffect(() => {
        // 模拟第一次加载时获取问题的答案
        setDlgShow(props.show);
    }, [props.show]);

    useEffect(() => {
        // 每次history更新时，滚动到底部
        const historyEl = document.querySelector('.history');
        if (historyEl) {
            historyEl.scrollTop = historyEl.scrollHeight;
        }
    }, [history]);

    useEffect(() => {
        // 加载历史记录
        setHistory(loadHistory());
    }, []);

    const onHide = () => {
        setDlgShow(false);
        if (props.onHide) {
            props.onHide();
        }
    }

    // 计算当前页面的高度
    const pageHeight = document.documentElement.clientHeight;

    return (
        <AccessibleModal dialogClassName="AIChatContainer" onHide={onHide} className="figure-modal" show={dlgShow} backdrop="static" keyboard={false}>
            <Modal.Header closeButton>
                <Modal.Title>
                    {'AI助手'}
                </Modal.Title>
            </Modal.Header>

            <Modal.Body>
                <div className="AIChat">
                    <div className="history" style={{
                        maxHeight: pageHeight - 300,
                        overflowY: 'auto',
                        minHeight: 300,
                    }}>
                        {history.map((item, index) => (
                            <div key={index} className="history-item">
                                <p className="question">问题: {item.question}</p >
                                <p className="answer">回复: {item.answer}</p >
                            </div>
                        ))}
                    </div>
                    {isProcessing ? (<div className="bottom-div">正在请求数据，请稍候...</div>) : (
                        <div className="bottom-div">
                            <form className="question-form" onSubmit={handleSubmit}>
                                <input
                                    type="text"
                                    value={question}
                                    onChange={(e) => setQuestion(e.target.value)}
                                    placeholder="请输入你的问题..."
                                    className="question-input"
                                />
                                <Button type="submit" className="submit-button">提交</Button>
                            </form>
                        </div>
                    )}
                </div>

            </Modal.Body>
        </AccessibleModal>
    )
}