import type { Port } from '../../../../packages/shared/src/index.js';

// The approved socket geometry is shared unchanged at every port density.
export const RJ45_SOCKET_PATH = 'M30 29H90V70H79V86H41V70H30Z';
export function Connector({
  kind,
  color,
}: {
  kind: Port['kind'];
  color: string;
}) {
  return (
    <svg
      className="visual-connector"
      data-connector={kind}
      viewBox="0 0 120 112"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        data-vlan-border="true"
        x="13"
        y="9"
        width="94"
        height="94"
        rx="11"
        fill="#202b34"
        stroke={color}
        strokeWidth="4.5"
      />
      {kind === 'rj45' ? (
        <>
          <path
            data-socket="rj45"
            d={RJ45_SOCKET_PATH}
            fill="#0b1620"
            stroke="#8c9ba9"
            strokeWidth="3.2"
          />
          {Array.from({ length: 8 }, (_, index) => (
            <rect
              data-contact="gold"
              key={index}
              x={34 + index * 6.6}
              y="32"
              width="4.8"
              height="13"
              fill="#baa264"
            />
          ))}
        </>
      ) : kind === 'sfp' || kind === 'sfp_plus' ? (
        <>
          <rect
            data-socket={kind}
            x="28"
            y="33"
            width="64"
            height="39"
            rx="2"
            fill="#0b1620"
            stroke="#97a6b1"
            strokeWidth="3.2"
          />
          <path
            d="M34 39H86V61H77V67H43V61H34Z"
            fill="#101b23"
            stroke="#728591"
            strokeWidth="2"
          />
          <path d="M40 76H80M46 81H74" stroke="#8c9ba9" strokeWidth="2" />
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <rect
              key={index}
              x={40 + index * 7}
              y="37"
              width="4"
              height="6"
              fill="#baa264"
            />
          ))}
          <text
            x="60"
            y="95"
            textAnchor="middle"
            fill="#c1d2de"
            fontSize="10"
            fontFamily="sans-serif"
          >
            {kind === 'sfp_plus' ? 'SFP+' : 'SFP'}
          </text>
        </>
      ) : kind === 'qsfp' ? (
        <>
          <rect
            data-socket="qsfp"
            x="24"
            y="34"
            width="72"
            height="43"
            rx="2"
            fill="#0b1620"
            stroke="#97a6b1"
            strokeWidth="3.2"
          />
          {[0, 1, 2, 3].map((index) => (
            <rect
              key={index}
              x={31 + index * 15}
              y="43"
              width="12"
              height="22"
              fill="#1e303b"
              stroke="#82939e"
            />
          ))}
          <path d="M35 82H85" stroke="#a6b7c2" strokeWidth="2" />
          <text
            x="60"
            y="95"
            textAnchor="middle"
            fill="#c1d2de"
            fontSize="10"
            fontFamily="sans-serif"
          >
            QSFP
          </text>
        </>
      ) : (
        <>
          <circle
            data-socket="other"
            cx="60"
            cy="54"
            r="22"
            fill="#0b1620"
            stroke="#97a6b1"
            strokeWidth="3.2"
          />
          <circle cx="60" cy="54" r="8" fill="#8c9ba9" />
          <text
            x="60"
            y="94"
            textAnchor="middle"
            fill="#c1d2de"
            fontSize="10"
            fontFamily="sans-serif"
          >
            OTHER
          </text>
        </>
      )}
    </svg>
  );
}
