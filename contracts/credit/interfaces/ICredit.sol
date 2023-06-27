// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface ICredit {
    function drawdown(bytes32 creditHash, uint256 borrowAmount) external;

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) external returns (uint256 amountPaid, bool paidoff);

    function refreshPnL() external returns (uint256 profit, uint256 loss);

    function currentPnL() external view returns (uint256 profit, uint256 loss);

    function submitPrincipalWithdrawal(uint256 amount) external;
}
