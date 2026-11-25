import React, { useState, forwardRef, useImperativeHandle } from "react";
import { Tabs, Tab } from 'react-bootstrap';
import { useTranslation } from 'react-i18next';

// 分类公式模板定义
const FORMULA_CATEGORIES = {
  calculus: {
    labelKey: 'formula_calculus',
    templates: [
      { id: 'sqrt', latex: '\\sqrt{x}' },
      { id: 'nthroot', latex: '\\sqrt[n]{x}' },
      { id: 'frac', latex: '\\frac{x}{y}' },
      { id: 'power', latex: 'x^{2}' },
      { id: 'subscript', latex: 'x_{i}' },
      { id: 'sum', latex: '\\sum_{a}^{b}x' },
      { id: 'sum_i', latex: '\\sum_{i=1}^{n}x_i' },
      { id: 'prod', latex: '\\prod_{i}^{n}x_i' },
      { id: 'integral', latex: '\\int f(x)\\,dx' },
      { id: 'integral_def', latex: '\\int_{a}^{b}y\\,dx' },
      { id: 'derivative', latex: '\\frac{dx}{dy}' },
      { id: 'derivative_f', latex: '\\frac{d}{dx}f(x)' },
      { id: 'partial', latex: '\\frac{\\partial y}{\\partial x}' },
      { id: 'limit', latex: '\\lim_{x \\to \\infty}f(x)' },
      { id: 'double_integral', latex: '\\iint_{D} f(x,y)\\,dx\\,dy' },
      { id: 'triple_integral', latex: '\\iiint_{V} f(x,y,z)\\,dx\\,dy\\,dz' },
      { id: 'line_integral', latex: '\\oint_{C} f(x)\\,dx' },
    ]
  },
  trigonometry: {
    labelKey: 'formula_trigonometry',
    templates: [
      { id: 'sin', latex: '\\sin(x)' },
      { id: 'cos', latex: '\\cos(x)' },
      { id: 'tan', latex: '\\tan(x)' },
      { id: 'arcsin', latex: '\\arcsin(x)' },
      { id: 'arccos', latex: '\\arccos(x)' },
      { id: 'arctan', latex: '\\arctan(x)' },
      { id: 'sinh', latex: '\\sinh(x)' },
      { id: 'cosh', latex: '\\cosh(x)' },
      { id: 'tanh', latex: '\\tanh(x)' },
      { id: 'sec', latex: '\\sec(x)' },
      { id: 'csc', latex: '\\csc(x)' },
      { id: 'cot', latex: '\\cot(x)' },
      { id: 'sin2x', latex: '\\sin(2x) = 2\\sin(x)\\cos(x)' },
      { id: 'cos2x', latex: '\\cos(2x) = \\cos^{2}(x) - \\sin^{2}(x)' },
      { id: 'sin_sum', latex: '\\sin(A + B) = \\sin(A)\\cos(B) + \\cos(A)\\sin(B)' },
      { id: 'cos_sum', latex: '\\cos(A + B) = \\cos(A)\\cos(B) - \\sin(A)\\sin(B)' },
    ]
  },
  greek_letters: {
    labelKey: 'formula_greek_letters',
    templates: [
      { id: 'alpha', latex: '\\alpha' },
      { id: 'beta', latex: '\\beta' },
      { id: 'gamma', latex: '\\gamma' },
      { id: 'delta', latex: '\\delta' },
      { id: 'epsilon', latex: '\\epsilon' },
      { id: 'zeta', latex: '\\zeta' },
      { id: 'eta', latex: '\\eta' },
      { id: 'theta', latex: '\\theta' },
      { id: 'iota', latex: '\\iota' },
      { id: 'kappa', latex: '\\kappa' },
      { id: 'lambda', latex: '\\lambda' },
      { id: 'mu', latex: '\\mu' },
      { id: 'nu', latex: '\\nu' },
      { id: 'xi', latex: '\\xi' },
      { id: 'pi', latex: '\\pi' },
      { id: 'rho', latex: '\\rho' },
      { id: 'sigma', latex: '\\sigma' },
      { id: 'tau', latex: '\\tau' },
      { id: 'upsilon', latex: '\\upsilon' },
      { id: 'phi', latex: '\\phi' },
      { id: 'chi', latex: '\\chi' },
      { id: 'psi', latex: '\\psi' },
      { id: 'omega', latex: '\\omega' },
    ]
  },
  other: {
    labelKey: 'formula_other',
    templates: [
      { id: 'multiply', latex: 'x\\cdot y' },
      { id: 'ln', latex: '\\ln(x)' },
      { id: 'log', latex: '\\log_{a}(x)' },
      { id: 'exp', latex: '\\exp(x)' },
      { id: 'infinity', latex: '\\infty' },
      { id: 'pm', latex: '\\pm' },
      { id: 'mp', latex: '\\mp' },
      { id: 'approx', latex: '\\approx' },
      { id: 'sim', latex: '\\sim' },
      { id: 'equiv', latex: '\\equiv' },
      { id: 'neq', latex: '\\neq' },
      { id: 'leq', latex: '\\leq' },
      { id: 'geq', latex: '\\geq' },
      { id: 'subset', latex: '\\subset' },
      { id: 'supset', latex: '\\supset' },
      { id: 'in', latex: '\\in' },
      { id: 'cap', latex: '\\cap' },
      { id: 'cup', latex: '\\cup' },
      { id: 'forall', latex: '\\forall' },
      { id: 'exists', latex: '\\exists' },
    ]
  }
};

interface VMathProps { }

const VMath = forwardRef<any, VMathProps>((props, ref) => {
  const { t } = useTranslation();
  const [latex, setLatex] = useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    getExpression: () => () => latex,
  }));

  // 插入公式模板 - 在光标位置插入
  const insertTemplate = (template: { id: string; latex: string }) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      // 如果没有 textarea 引用，直接追加到末尾
      setLatex(prev => prev + template.latex);
      return;
    }

    const cursorPos = textarea.selectionStart || 0;
    const textBefore = latex.substring(0, cursorPos);
    const textAfter = latex.substring(cursorPos);
    const newLatex = textBefore + template.latex + textAfter;

    setLatex(newLatex);

    // 设置新的光标位置（在插入的公式之后）
    setTimeout(() => {
      const newCursorPos = cursorPos + template.latex.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
      textarea.focus();
    }, 0);
  };

  // 处理文本输入
  const handleLatexChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLatex(e.target.value);
  };

  return (
    <div style={{ padding: '10px' }}>
      {/* Tab 选项卡，分类显示公式 */}
      <Tabs 
        defaultActiveKey="calculus" 
        id="formula-tabs"
        className="mb-3"
        style={{ marginBottom: '16px', fontSize: '12px' }}
      >
        {Object.entries(FORMULA_CATEGORIES).map(([key, category]) => (
          <Tab eventKey={key} title={t(category.labelKey)} key={key}>
            {/* 公式按钮区域 - 6列布局 */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(6, 1fr)',
              gap: '8px',
              marginTop: '16px'
            }}>
              {category.templates.map((template) => (
                <button
                  key={template.id}
                  onClick={() => insertTemplate(template)}
                  style={{
                    padding: '8px',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    background: 'white',
                    cursor: 'pointer',
                    fontSize: '14px',
                    minHeight: '40px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = '#f0f0f0';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'white';
                  }}
                  title={template.latex}
                >
                  <span dangerouslySetInnerHTML={{
                    __html: renderLatexToHTML(template.latex)
                  }} />
                </button>
              ))}
            </div>
          </Tab>
        ))}
      </Tabs>

      {/* LaTeX 编辑区域 */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
          <label style={{ fontWeight: 'bold' }}>
            {t('latex_code') || 'LaTeX 代码'}:
          </label>
          <button
            onClick={() => setLatex('')}
            style={{
              padding: '4px 12px',
              fontSize: '12px',
              border: '1px solid #ddd',
              borderRadius: '4px',
              background: '#f5f5f5',
              cursor: 'pointer',
              fontWeight: 'bold',
              color: '#666',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#e8e8e8';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#f5f5f5';
            }}
          >
            {t('clear') || 'Clear'}
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={latex}
          onChange={handleLatexChange}
          placeholder={t('enter_latex_formula') || '点击上方按钮插入公式，或直接输入 LaTeX 代码...'}
          style={{
            width: '100%',
            minHeight: '100px',
            padding: '8px',
            fontFamily: 'monospace',
            fontSize: '14px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            resize: 'vertical',
          }}
        />
      </div>

      {/* 预览区域 */}
      <div style={{ marginTop: '16px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontWeight: 'bold' }}>
          {t('preview') || '预览'}:
        </label>
        <div
          style={{
            padding: '16px',
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#f9f9f9',
            minHeight: '60px',
            fontSize: '18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {latex ? (
            <span dangerouslySetInnerHTML={{ __html: renderLatexToHTML(latex) }} />
          ) : (
            <span style={{ color: '#999' }}>
              {t('formula_preview_here') || '公式预览将显示在这里'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

// 简单的 LaTeX 到 HTML 渲染（用于预览）
function renderLatexToHTML(latex: string): string {
  let html = latex;

  // 处理分数
  html = html.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g,
    '<span style="display:inline-block;vertical-align:middle;text-align:center;"><span style="display:block;border-bottom:1px solid black;padding:0 4px;">$1</span><span style="display:block;padding:0 4px;">$2</span></span>');

  // 处理根号
  html = html.replace(/\\sqrt\[([^]]*)\]\{([^}]*)\}/g, '<sup style="font-size:0.7em;">$1</sup>√<span style="text-decoration:overline;">$2</span>');
  html = html.replace(/\\sqrt\{([^}]*)\}/g, '√<span style="text-decoration:overline;">$1</span>');

  // 处理上标
  html = html.replace(/\^\\infty/g, '<sup>∞</sup>');
  html = html.replace(/\^\\pi/g, '<sup>π</sup>');
  html = html.replace(/\^([a-zA-Z0-9])/g, '<sup>$1</sup>');
  html = html.replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>');

  // 处理下标
  html = html.replace(/_([a-zA-Z0-9])/g, '<sub>$1</sub>');
  html = html.replace(/\_\{([^}]*)\}/g, '<sub>$1</sub>');

  // 处理求和符号
  html = html.replace(/\\sum/g, '∑');

  // 处理连乘符号
  html = html.replace(/\\prod/g, '∏');

  // 处理积分符号
  html = html.replace(/\\iiint/g, '∭');
  html = html.replace(/\\iint/g, '∬');
  html = html.replace(/\\int/g, '∫');
  html = html.replace(/\\oint/g, '∮');

  // 处理极限
  html = html.replace(/\\lim/g, 'lim');
  html = html.replace(/\\to/g, '→');

  // 处理导数
  html = html.replace(/\\frac\{d\}/g, '<span style="display:inline-block;vertical-align:middle;text-align:center;"><span style="display:block;border-bottom:1px solid black;padding:0 4px;">d</span>');
  html = html.replace(/\\frac\{\\partial([^}]*)\}/g, '<span style="display:inline-block;vertical-align:middle;text-align:center;"><span style="display:block;border-bottom:1px solid black;padding:0 4px;">∂$1</span>');

  // 处理偏导数符号
  html = html.replace(/\\partial/g, '∂');

  // 处理对数
  html = html.replace(/\\ln/g, 'ln');
  html = html.replace(/\\log/g, 'log');
  html = html.replace(/\\exp/g, 'exp');

  // 处理三角函数
  html = html.replace(/\\sin/g, 'sin');
  html = html.replace(/\\cos/g, 'cos');
  html = html.replace(/\\tan/g, 'tan');
  html = html.replace(/\\arcsin/g, 'arcsin');
  html = html.replace(/\\arccos/g, 'arccos');
  html = html.replace(/\\arctan/g, 'arctan');
  html = html.replace(/\\sinh/g, 'sinh');
  html = html.replace(/\\cosh/g, 'cosh');
  html = html.replace(/\\tanh/g, 'tanh');
  html = html.replace(/\\sec/g, 'sec');
  html = html.replace(/\\csc/g, 'csc');
  html = html.replace(/\\cot/g, 'cot');

  // 处理乘号
  html = html.replace(/\\cdot/g, '·');

  // 处理空格
  html = html.replace(/\\,/g, ' ');
  html = html.replace(/\\;/g, '  ');

  // 处理括号
  html = html.replace(/\\left/g, '');
  html = html.replace(/\\right/g, '');

  // 处理常见希腊字母
  html = html.replace(/\\alpha/g, 'α');
  html = html.replace(/\\beta/g, 'β');
  html = html.replace(/\\gamma/g, 'γ');
  html = html.replace(/\\delta/g, 'δ');
  html = html.replace(/\\epsilon/g, 'ε');
  html = html.replace(/\\zeta/g, 'ζ');
  html = html.replace(/\\eta/g, 'η');
  html = html.replace(/\\theta/g, 'θ');
  html = html.replace(/\\iota/g, 'ι');
  html = html.replace(/\\kappa/g, 'κ');
  html = html.replace(/\\lambda/g, 'λ');
  html = html.replace(/\\mu/g, 'μ');
  html = html.replace(/\\nu/g, 'ν');
  html = html.replace(/\\xi/g, 'ξ');
  html = html.replace(/\\pi/g, 'π');
  html = html.replace(/\\rho/g, 'ρ');
  html = html.replace(/\\sigma/g, 'σ');
  html = html.replace(/\\tau/g, 'τ');
  html = html.replace(/\\upsilon/g, 'υ');
  html = html.replace(/\\phi/g, 'φ');
  html = html.replace(/\\chi/g, 'χ');
  html = html.replace(/\\psi/g, 'ψ');
  html = html.replace(/\\omega/g, 'ω');

  // 处理无穷大
  html = html.replace(/\\infty/g, '∞');

  // 处理其他符号
  html = html.replace(/\\pm/g, '±');
  html = html.replace(/\\mp/g, '∓');
  html = html.replace(/\\approx/g, '≈');
  html = html.replace(/\\sim/g, '~');
  html = html.replace(/\\equiv/g, '≡');
  html = html.replace(/\\neq/g, '≠');
  html = html.replace(/\\leq/g, '≤');
  html = html.replace(/\\geq/g, '≥');
  html = html.replace(/\\subset/g, '⊂');
  html = html.replace(/\\supset/g, '⊃');
  html = html.replace(/\\in/g, '∈');
  html = html.replace(/\\cap/g, '∩');
  html = html.replace(/\\cup/g, '∪');
  html = html.replace(/\\forall/g, '∀');
  html = html.replace(/\\exists/g, '∃');

  return html;
}

export default VMath;
