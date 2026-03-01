import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { apiFetch } from '../api'

function fmt(n) {
  const v = Number(n || 0)
  return `${v} ₽`
}

export default function Wallet() {
  const { me, token, balanceInfo, topup, refreshBalance } = useAuth()
  const nav = useNavigate()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!me) nav('/login')
  }, [me, nav])

  async function doTopup(amount) {
    setErr('')
    setBusy(true)
    try {
      await topup(amount)
    } catch (e) {
      setErr(e.message || 'Ошибка пополнения')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (token) refreshBalance?.()
  }, [token])

  if (!me) return null

  return (
    <div className="grid">
      <div className="card">
        <h2 className="h2">Баланс (пробный)</h2>
        <div className="sub">Это демо-баланс для MVP. Реальных платежей пока нет.</div>

        {err && <div className="err">{err}</div>}

        <div className="kpiRow" style={{ marginTop: 12 }}>
          <div className="kpi">
            <div className="small">Текущий баланс</div>
            <div className="h2">{fmt(balanceInfo?.balance)}</div>
          </div>
          <div className="kpi">
            <div className="small">Доход репетитора</div>
            <div className="h2">{fmt(balanceInfo?.earnings)}</div>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="label">Пополнить (пробно)</div>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {[200, 500, 1000, 2000, 5000].map(a => (
              <button key={a} className="btn btnPrimary" disabled={busy} onClick={() => doTopup(a)}>
                +{a} ₽
              </button>
            ))}
            <button className="btn" disabled={busy} onClick={() => refreshBalance?.()}>Обновить</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 className="h3">Операции</h3>
        <div className="sub">Последние 25 операций (для MVP достаточно).</div>
        <div style={{ marginTop: 12 }}>
          {(balanceInfo?.tx || []).length === 0 && <div className="small">Операций пока нет.</div>}
          {(balanceInfo?.tx || []).map(t => (
            <div key={t.id} className="listItem">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {t.kind} {t.amount > 0 ? `+${t.amount}` : t.amount} ₽
                    {t.booking_id ? <span className="small"> • booking #{t.booking_id}</span> : null}
                  </div>
                  {t.note ? <div className="small">{t.note}</div> : null}
                </div>
                <div className="small">{new Date(t.created_at).toLocaleString()}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 className="h3">Как это будет работать позже</h3>
        <ul className="ul">
          <li>Ученик пополняет баланс в платформе</li>
          <li>Платформа списывает оплату за занятие и учитывает комиссию</li>
          <li>Репетитор видит начисления и получает выплаты по расписанию</li>
        </ul>
      </div>
    </div>
  )
}
