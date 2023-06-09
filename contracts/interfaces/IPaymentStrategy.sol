// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IPaymentStrategy {
    function calculateInterestAndPrincipal(
        uint256[] memory params
    ) external view returns (uint256 accruedInterest, uint256 accruedPrincipal);
}
