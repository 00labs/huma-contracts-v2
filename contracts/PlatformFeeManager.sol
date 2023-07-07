// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

struct FeeInfo {
    uint96 protocolFee;
    uint96 ownerFee;
    // todo add eaFee and firstLossCoverFee
}

contract PlatformFeeManager {
    // :Add functions to configure rate for pool owner, ea, and first loss cover

    function distributePlatformFees(uint256 profit) external {
        // calculate fees and tranches assets
        uint96[] memory fees = _getProfitDistribution(profit);

        // :reference v1 contract
    }

    function getRemaining(uint256 profit) external view returns (uint256 remaining) {}

    function _getProfitDistribution(uint256 profit) internal view returns (uint96[] memory fees) {
        // calculate fees
        uint256[] memory feeParams = new uint256[](3);
        feeParams[0] = profit;
        (uint256 protocolFee, uint256 ownerFee, uint256 remaining) = (0, 0, 0); //feeManager.calculateFees(feeParams);
        fees[0] = uint96(protocolFee);
        fees[1] = uint96(ownerFee);
        // :Need to support eaFee and firstLossCoverFee.
    }

    // :Reference v1 contracts and add functions for the admin accounts to withdraw their fees
}
