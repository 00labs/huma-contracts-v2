// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IPoolCredit {
    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery);

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery);
}
