// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, ReceivableInfo, FacilityConfig} from "./CreditStructs.sol";
import {BaseCredit} from "./BaseCredit.sol";
import {ICreditFacility} from "./interfaces/ICreditFacility.sol";

/**
 * CreditFacility provides a debt facility for the borrowers to sell their receivabels to the
 * facility to gain access to credit.
 */
abstract contract CreditFacility is BaseCredit, ICreditFacility {
    // creditHash => (receivableHash => receivableInfo)
    mapping(bytes32 => mapping(bytes32 => ReceivableInfo)) receivables;
    mapping(bytes32 => bool) approvedReceivables;

    mapping(bytes32 => FacilityConfig) facilityConfig;

    function addReceivable(bytes32 creditHash, ReceivableInfo memory receivableInfo) public {
        bytes32 receivableHash = _genReceivableHash(receivableInfo);
        mapping(bytes32 => ReceivableInfo) storage tempReceivableMap = receivables[creditHash];
        tempReceivableMap[receivableHash] = receivableInfo;

        // todo read facilityConfig twice when if is true, need to improve efficiency.
        if (facilityConfig[creditHash].autoApproval) approveReceivable(creditHash, receivableInfo);
    }

    function approveReceivable(bytes32 creditHash, ReceivableInfo memory receivableInfo) public {
        bytes32 receivableHash = _genReceivableHash(receivableInfo);
        approvedReceivables[receivableHash] = true;
        _creditRecordMap[creditHash].availableCredit +=
            receivableInfo.receivableAmount *
            facilityConfig[creditHash].advanceRateInBps;
    }

    function bookReceivablePayment(ReceivableInfo memory receivableInfo) external {}

    function closeReceivable(ReceivableInfo memory receivableInfo) external {}

    function drawdownWithReceivable(
        bytes32 creditHash,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external {
        addReceivable(creditHash, receivableInfo);
        //super.drawdown(creditHash, amount);
    }

    function _genReceivableHash(
        ReceivableInfo memory receivableInfo
    ) internal view returns (bytes32 receivableHash) {
        receivableHash = keccak256(
            abi.encode(address(receivableInfo.receivableAsset), receivableInfo.receivableId)
        );
    }
}
