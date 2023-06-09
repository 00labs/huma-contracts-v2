// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IFeeManager {
    function calculateFees(
        uint256[] memory params
    ) external view returns (uint256 protocolFee, uint256 ownerFee, uint256 remaining);
}
