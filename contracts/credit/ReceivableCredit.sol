// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, CreditRecord, ReceivableInfo, FacilityConfig, ReceivableState} from "./CreditStructs.sol";
import {BaseCredit} from "./BaseCredit.sol";
import {IReceivableCredit} from "./interfaces/IReceivableCredit.sol";
import {Receivable} from "./Receivable.sol";
import {Errors} from "../Errors.sol";

/**
 * ReceivableCredit is a credit backed by receivables.
 */
contract ReceivableCredit is BaseCredit, IReceivableCredit {
    // the NFT contract address for the receivable.
    // todo set Receivable in initializer.
    Receivable receivable;

    // creditHash => (receivableId => receivableId)
    // map from creditHash to the list of receivables.
    // Used a map to store a list of receivables instead of an array for efficiency consideration.
    mapping(bytes32 => mapping(uint256 => uint256)) receivableMap;

    // creditHash => FacilityConfig, the facility config for the credit
    mapping(bytes32 => FacilityConfig) facilityConfig;

    function approveReceivable(bytes32 creditHash, uint256 receivableId) public {
        // todo onlyEA
        _approveReceivable(creditHash, receivableId);
    }

    /**
     * @notice Approves a receivable and adjusts available credit
     */
    function _approveReceivable(bytes32 creditHash, uint256 receivableId) internal {
        receivable.approveOrRejectReceivable(receivableId, true);

        _creditRecordMap[creditHash].availableCredit +=
            receivable.getReceivable(receivableId).receivableAmount *
            facilityConfig[creditHash].advanceRateInBps;
    }

    function rejectReceivable(bytes32 creditHash, uint256 receivableId) public {
        // todo onlyEA
        receivable.approveOrRejectReceivable(receivableId, false);
    }

    function drawdownWithReceivable(
        bytes32 creditHash,
        uint256 receivableId,
        uint256 amount,
        ReceivableInfo memory receivableInfo
    ) external {
        // todo check receivable has been approved and owned by the borrower
        //super.drawdown(creditHash, amount);
    }

    function _getCreditHash(uint256 receivableId) internal view returns (bytes32 creditHash) {
        if (_getBorrowerRecord(msg.sender).borrowerLevelCredit)
            creditHash = getCreditHash(msg.sender);
        else creditHash = getCreditHash(msg.sender, address(receivable), receivableId);
    }
}
